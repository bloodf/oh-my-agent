/**
 * Purpose: Build the synthetic user root a worker process runs inside (§5.2).
 * Each spawn gets its own HOME + XDG_* tree whose OMP agent dir contains only
 * the worker's generated native definition and the definitions named by
 * `spawns:`, a config that pins `task.disabledAgents` to every discovered agent
 * outside that allowlist, and a `models.yml` routing every turn through the
 * per-worker inference gateway.
 *
 * Public API: `materializeWorker(options: MaterializeOptions): Promise<WorkerLayout>`.
 *
 * Upstream deps: `node:fs/promises`, `node:path`, `../shared/agent-definition`
 * (`PeerDefinition`, `fingerprintPeerDefinition`).
 *
 * Downstream consumers: the daemon's worker lifecycle — it materializes before
 * launching an RPC worker and re-materializes whenever the definition
 * fingerprint changes.
 *
 * Failure modes: a `spawns:` entry, mcp, or skill with no source definition
 * rejects; a name that would escape the agent dir rejects. Every rejection
 * happens before any destructive write, so a failed rebuild leaves the previous
 * materialization byte-identical.
 *
 * Performance: one staged tree write per spawn — bounded by the worker's own
 * definition plus its spawns closure, not by the user's full agent set.
 */
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { PeerDefinition } from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InferenceGateway {
	/** Loopback base URL of the worker's pi-native inference gateway. */
	url: string;
	/** Per-worker bearer. Passed through env; never written to disk. */
	token: string;
}

export interface MCPServerSpec {
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	transport?: "stdio" | "http" | "sse";
}

export interface MaterializeOptions {
	/** Worker root. Everything generated lives under it. */
	rootDir: string;
	parsedPeer: PeerDefinition;
	/** `discoverAgents(workerCwd)` names, for the defense-in-depth deny-list. */
	discoveredAgentNames: string[];
	inferenceGateway: InferenceGateway;
	/**
	 * Model the worker selects, as `provider/id` (e.g. `anthropic/claude-opus-4-6`).
	 * That provider is the one pointed at the gateway. Defaults to the peer's own
	 * `model:` frontmatter.
	 */
	model?: string;
	/** Raw markdown for each agent nameable through `spawns:`. */
	sourceSpawnAgents?: Record<string, string>;
	/** Available MCP servers, keyed by the name a peer selects with `mcps:`. */
	sourceMCPs?: Record<string, MCPServerSpec>;
	/** Available skill roots, keyed by the name a peer selects with `skills:`. */
	sourceSkillRoots?: Record<string, string>;
}

export interface WorkerLayout {
	root: string;
	home: string;
	agentDir: string;
	sessionDir: string;
	generatedAgentPath: string;
	configPath: string;
	modelsPath: string;
	/** Provider/model the worker selects; the provider routes to the gateway. */
	provider: string;
	modelId: string;
	/** Gateway the worker's turns route through; sandbox policy needs it. */
	inferenceGateway: { host: string; port: number };
	mcpPath?: string;
	skillPaths: string[];
	/** Discovered agents denied to this worker, ascending. */
	disabledAgents: string[];
	definitionFingerprint: string;
	/** Process env for the worker: synthetic roots + inference bearer only. */
	env: Record<string, string>;
}

/** Env var the generated `models.yml` names as its `apiKey` source. */
const INFERENCE_TOKEN_ENV = "OH_MY_AGENT_INFERENCE_TOKEN";

// ── Helpers ───────────────────────────────────────────────────────────────────

export class MaterializationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MaterializationError";
	}
}

/**
 * Reject any selector that is not a plain single path segment. Materialized
 * names become filenames under the agent dir, so `..`, separators, and absolute
 * paths must never reach a join.
 */
function assertPlainName(kind: string, name: string): void {
	if (
		name.length === 0 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		name.includes(sep)
	) {
		throw new MaterializationError(`Unsafe ${kind} name: ${JSON.stringify(name)}`);
	}
}

function assertContained(root: string, candidate: string, description: string): void {
	const resolvedRoot = resolve(root);
	const resolvedCandidate = resolve(candidate);
	if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + sep)) {
		throw new MaterializationError(`${description} escapes ${resolvedRoot}: ${resolvedCandidate}`);
	}
}

/** YAML-quote a scalar. Generated files are machine-written, so quote always. */
function yamlString(value: string): string {
	return JSON.stringify(value);
}

/**
 * Render the worker's native OMP definition: native fields only. Private
 * oh-my-agent extras (rooms, wake, autonomy, workspace, schedules, automations,
 * mcps, skills) stay in the daemon and never reach the worker's agent dir.
 */
function renderNativeDefinition(peer: PeerDefinition): string {
	const lines = [`name: ${yamlString(peer.name)}`, `description: ${yamlString(peer.description)}`];

	const model = Array.isArray(peer.model) ? peer.model : peer.model ? [peer.model] : [];
	if (model.length > 0) lines.push(`model: [${model.map(yamlString).join(", ")}]`);
	if (peer.tools && peer.tools.length > 0) {
		lines.push(`tools: [${peer.tools.map(yamlString).join(", ")}]`);
	}
	lines.push(
		peer.spawns === "*"
			? `spawns: ${yamlString("*")}`
			: `spawns: [${peer.spawns.map(yamlString).join(", ")}]`,
	);

	return `---\n${lines.join("\n")}\n---\n${peer.body}`;
}

function renderConfig(disabledAgents: string[]): string {
	const list =
		disabledAgents.length === 0
			? "[]"
			: `\n${disabledAgents.map((name) => `    - ${yamlString(name)}`).join("\n")}`;
	return [
		"# Generated by oh-my-agent. Rebuilt on every spawn; edits are discarded.",
		"task:",
		"  maxRecursionDepth: 2",
		`  disabledAgents: ${list}`,
		"tools:",
		"  approvalMode: yolo",
		"",
	].join("\n");
}

/**
 * `apiKey` names an env var rather than carrying the bearer: OMP's
 * `resolveConfigValue` checks the environment before falling back to a literal,
 * so the token reaches the provider from `env` and never lands on disk.
 *
 * Deliberately a provider override with NO `models:` block. `finalizeCustomModel`
 * (custom-models.ts:124-148) builds config-defined models without a `transport`
 * field, so a custom model can never carry `pi-native` — its turns would leave
 * for the real provider endpoint and bypass the credential gateway. Provider
 * overrides do keep the transport (`model-registry.ts:783`, `:1299`), so the
 * worker selects a bundled model id under this provider and every turn is
 * dispatched to the gateway's `/v1/pi/stream`.
 */
function renderModels(gatewayUrl: string, provider: string): string {
	return [
		"# Generated by oh-my-agent. Rebuilt on every spawn; edits are discarded.",
		"providers:",
		`  ${provider}:`,
		`    baseUrl: ${gatewayUrl}`,
		`    apiKey: ${INFERENCE_TOKEN_ENV}`,
		"    transport: pi-native",
		"",
	].join("\n");
}

/**
 * Split a peer's `model:` selector into provider and id. The provider is the
 * one redirected to the gateway, so a bare id cannot be routed — every worker
 * needs a fully qualified `provider/id`.
 */
function resolveWorkerModel(
	peer: PeerDefinition,
	override?: string,
): { provider: string; modelId: string } {
	const selector = override ?? (Array.isArray(peer.model) ? peer.model[0] : peer.model);
	if (typeof selector !== "string" || selector.trim().length === 0) {
		throw new MaterializationError(
			`Peer ${peer.name} declares no model; a worker needs an explicit provider/id to route through the gateway`,
		);
	}
	const trimmed = selector.trim();
	const separator = trimmed.indexOf("/");
	const provider = separator > 0 ? trimmed.slice(0, separator) : "";
	const modelId = separator > 0 ? trimmed.slice(separator + 1) : "";
	if (!provider || !modelId) {
		throw new MaterializationError(
			`Peer ${peer.name} model ${JSON.stringify(selector)} must be fully qualified as provider/id`,
		);
	}
	return { provider, modelId };
}

/**
 * Split the gateway URL into the host/port the sandbox policy must allow.
 * An implicit port is rejected: the compiler needs a real port, and a URL
 * without one would silently become `0`.
 */
function parseGatewayEndpoint(url: string): { host: string; port: number } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new MaterializationError(`Inference gateway url is not a URL: ${JSON.stringify(url)}`);
	}
	const port = Number(parsed.port);
	if (!parsed.port || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new MaterializationError(
			`Inference gateway url needs an explicit port: ${JSON.stringify(url)}`,
		);
	}
	// §7:137 routes sandboxed model traffic through the daemon's loopback
	// gateway, and the Darwin compiler hard-codes `127.0.0.1` (sandbox.ts:129).
	// A non-loopback host would compile a profile the worker never dials.
	if (parsed.hostname !== "127.0.0.1") {
		throw new MaterializationError(
			`Inference gateway must be loopback, got ${JSON.stringify(parsed.hostname)}`,
		);
	}
	return { host: parsed.hostname, port };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function materializeWorker(options: MaterializeOptions): Promise<WorkerLayout> {
	const { rootDir, parsedPeer, discoveredAgentNames, inferenceGateway } = options;
	const sourceSpawnAgents = options.sourceSpawnAgents ?? {};
	const sourceMCPs = options.sourceMCPs ?? {};
	const sourceSkillRoots = options.sourceSkillRoots ?? {};

	const root = resolve(rootDir);
	const home = join(root, "home");
	const agentDir = join(home, ".omp", "agent");
	const sessionDir = join(agentDir, "sessions");

	// ── Resolve every selection before touching the filesystem ────────────────
	assertPlainName("agent", parsedPeer.name);

	const spawnNames = parsedPeer.spawns === "*" ? [] : [...parsedPeer.spawns];
	const spawnDocs: { name: string; content: string }[] = [];
	for (const name of spawnNames) {
		assertPlainName("agent", name);
		const content = sourceSpawnAgents[name];
		if (content === undefined) {
			throw new MaterializationError(`No source definition for spawns entry: ${name}`);
		}
		spawnDocs.push({ name, content });
	}

	const selectedMCPs = parsedPeer.mcps ?? [];
	const mcpServers: Record<string, MCPServerSpec> = {};
	for (const name of selectedMCPs) {
		assertPlainName("mcp", name);
		const spec = sourceMCPs[name];
		if (spec === undefined) throw new MaterializationError(`Unknown mcp: ${name}`);
		mcpServers[name] = spec;
	}

	const selectedSkills = parsedPeer.skills ?? [];
	const skills: { name: string; source: string }[] = [];
	for (const name of selectedSkills) {
		assertPlainName("skill", name);
		const source = sourceSkillRoots[name];
		if (source === undefined) throw new MaterializationError(`Unknown skill: ${name}`);
		skills.push({ name, source });
	}

	// Resolve before any filesystem work so an unroutable model fails closed.
	const { provider, modelId } = resolveWorkerModel(parsedPeer, options.model);
	const gatewayEndpoint = parseGatewayEndpoint(inferenceGateway.url);

	const allowed = new Set(parsedPeer.spawns === "*" ? discoveredAgentNames : spawnNames);
	const disabledAgents =
		parsedPeer.spawns === "*"
			? []
			: [...new Set(discoveredAgentNames)].filter((name) => !allowed.has(name)).sort();

	// ── Stage the agent dir, then swap it in ──────────────────────────────────
	const staging = join(root, `.staging-${process.pid.toString(36)}-${Date.now().toString(36)}`);
	const stagedAgents = join(staging, "agents");
	const generatedAgentPath = join(agentDir, "agents", `${parsedPeer.name}.md`);
	const configPath = join(agentDir, "config.yml");
	const modelsPath = join(agentDir, "models.yml");
	const mcpPath = selectedMCPs.length > 0 ? join(agentDir, "mcp.json") : undefined;
	const skillPaths = skills.map(({ name }) => join(agentDir, "skills", name));

	assertContained(agentDir, generatedAgentPath, "generated definition");
	if (mcpPath) assertContained(agentDir, mcpPath, "mcp config");
	for (const path of skillPaths) assertContained(agentDir, path, "skill destination");

	await rm(staging, { recursive: true, force: true });
	try {
		await mkdir(stagedAgents, { recursive: true });
		await mkdir(join(staging, "sessions"), { recursive: true });

		await writeFile(
			join(stagedAgents, `${parsedPeer.name}.md`),
			renderNativeDefinition(parsedPeer),
			"utf8",
		);
		for (const { name, content } of spawnDocs) {
			await writeFile(join(stagedAgents, `${name}.md`), content, "utf8");
		}

		await writeFile(join(staging, "config.yml"), renderConfig(disabledAgents), "utf8");
		await writeFile(
			join(staging, "models.yml"),
			renderModels(inferenceGateway.url, provider),
			"utf8",
		);

		if (mcpPath) {
			await writeFile(
				join(staging, "mcp.json"),
				`${JSON.stringify({ mcpServers }, null, "\t")}\n`,
				"utf8",
			);
		}

		for (const { name, source } of skills) {
			await cp(source, join(staging, "skills", name), { recursive: true });
		}

		// Synthetic user root: HOME plus all four XDG dirs, because
		// discoverAgents() consults generic native config roots as well as the
		// agent dir — PI_CODING_AGENT_DIR alone does not reroot both.
		for (const dir of [
			join(home, ".config"),
			join(home, ".local", "share"),
			join(home, ".local", "state"),
			join(home, ".cache"),
			join(home, ".omp"),
		]) {
			await mkdir(dir, { recursive: true });
		}

		// Swap last: move the old tree aside rather than deleting it, so a failed
		// rename can put it back instead of leaving the worker with no agent dir.
		const previous = `${agentDir}.previous`;
		await rm(previous, { recursive: true, force: true });
		const hadPrevious = await rename(agentDir, previous).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
		try {
			await rename(staging, agentDir);
		} catch (error) {
			if (hadPrevious) await rename(previous, agentDir);
			throw error;
		}
		await rm(previous, { recursive: true, force: true });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}

	return {
		root,
		home,
		agentDir,
		sessionDir,
		generatedAgentPath,
		configPath,
		modelsPath,
		...(mcpPath ? { mcpPath } : {}),
		skillPaths,
		disabledAgents,
		provider,
		modelId,
		inferenceGateway: gatewayEndpoint,
		definitionFingerprint: fingerprintPeerDefinition(parsedPeer),
		env: {
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			PI_CODING_AGENT_DIR: agentDir,
			[INFERENCE_TOKEN_ENV]: inferenceGateway.token,
		},
	};
}
