/**
 * Purpose: Own a peer's long-lived OMP RPC subprocess (§9.1) — start it inside
 * the materialized worker dir (§5.2), prompt it, park it when idle, resume it,
 * and stop it. Delegation stays OMP-native (§5.1): the child keeps `task`, and
 * durable peers are created through the daemon toolbelt, never in-run.
 *
 * Public API: `startWorker(options): Promise<WorkerHandle>`,
 * `classifyAgentSpawn(payload): "peer" | "subtask"`.
 *
 * Upstream deps: `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client` (`RpcClient`),
 * `../daemon/materializer` (`WorkerLayout`), `../shared/agent-definition`.
 *
 * Downstream consumers: the daemon's scheduler and room bus, which wake a
 * parked worker and deliver batched messages as one prompt.
 *
 * Failure modes: a stopped worker refuses prompts and resumes — the daemon must
 * materialize a fresh one, since a stale definition may no longer match the
 * fingerprint. Park is deliberately lossy: policy-changing files never mutate
 * under a live process (§10.3).
 *
 * Performance: one child process per running peer. Parked peers hold only their
 * layout and fingerprint.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { WorkerLayout } from "../daemon/materializer";
import type { PeerDefinition } from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";
import type { SandboxLaunch } from "./launch-gate";
import { resolveSandboxLaunch } from "./launch-gate";
import type { SandboxPolicy } from "./sandbox";

export interface StartWorkerOptions {
	peer: PeerDefinition;
	/** Materialized synthetic root; supplies env, agent dir, and session dir. */
	layout: WorkerLayout;
	/** Project directory the worker edits. Not the synthetic root. */
	cwd: string;
	/** CLI entry point override, for tests and vendored installs. */
	cliPath?: string;
	/**
	 * Platform seam for gating an opted-in peer. Defaults to the host platform
	 * and a real `which`/loopback probe.
	 */
	sandboxAdapter?: {
		platform?: NodeJS.Platform;
		which?: (binary: string) => Promise<string | null>;
		probeBridge?: (host: string, port: number) => Promise<boolean>;
		adapterCommand?: string;
	};
	/** Per-turn ceiling for a prompt round-trip. */
	turnTimeoutMs?: number;
}

export type WorkerState = "running" | "parked" | "stopped";

export interface WorkerHandle {
	readonly name: string;
	readonly state: WorkerState;
	/** Live child's session id; undefined once parked or stopped. */
	readonly sessionId: string | undefined;
	/** Live child's OS pid; undefined once parked or stopped. */
	readonly pid: number | undefined;
	/** True when the child runs under a probed, compiled sandbox profile. */
	readonly sandboxed: boolean;
	readonly layout: WorkerLayout;
	readonly env: Record<string, string>;
	/** Fingerprint of the definition this worker was materialized from. */
	readonly fingerprint: string;
	/** The child's actual tool surface, read from its live session. */
	effectiveTools(): Promise<string[]>;
	/** Child stderr tail, for diagnosing a failed or empty turn. */
	stderr(): string;
	/** Observe every agent event; the room bus projects these into rooms. */
	onEvent(listener: (event: unknown) => void): () => void;
	/** Observe every tool the child dispatches. Returns an unsubscribe. */
	onToolCall(listener: (name: string) => void): () => void;
	/** Send a turn and wait for the child to go idle. */
	prompt(message: string): Promise<void>;
	park(): Promise<void>;
	resume(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * Which spawn verb a payload belongs to (§5.1). A durable peer names the rooms
 * it joins; a one-shot subtask names none and must go through native `task`
 * instead — `expected_output` alone does not make it durable.
 */
export function classifyAgentSpawn(payload: {
	rooms?: unknown;
	[key: string]: unknown;
}): "peer" | "subtask" {
	return Array.isArray(payload.rooms) && payload.rooms.length > 0
		? "peer"
		: "subtask";
}

/**
 * Absolute path to the installed OMP CLI. `RpcClient` defaults to a
 * cwd-relative `dist/cli.js`, which only resolves inside an OMP checkout — the
 * worker's cwd is the user's project.
 *
 * Deliberately walks `node_modules` ancestors instead of resolving the package
 * specifier. OMP's legacy-pi compat layer registers a process-global, permanent
 * `Bun.plugin` `onResolve` hook matching every `@oh-my-pi/*` specifier
 * (legacy-pi-compat.ts:2876) whose handler resolves that same specifier
 * (legacy-pi-compat.ts:1133). Once anything installs the shim — importing
 * `@oh-my-pi/pi-coding-agent/extensibility/skills` does — the re-entry leaves
 * every specifier-based resolver returning the real path behind accreted
 * `file:` prefixes, and the spawned child dies with `Module not found`. A
 * filesystem walk is plugin-proof; `existsSync` turns a bad layout into a named
 * error here rather than an opaque child-exit downstream.
 *
 * Exported so tests spawn through the same construction production uses; a
 * resolver duplicated in a test can pass while this one drifts.
 */
export function resolveOmpCli(): string {
	const suffix = join(
		"node_modules",
		"@oh-my-pi",
		"pi-coding-agent",
		"dist",
		"cli.js",
	);
	for (let dir = import.meta.dir; ; dir = dirname(dir)) {
		const candidate = join(dir, suffix);
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) break;
	}
	throw new Error(
		`Cannot locate the OMP CLI: no ${suffix} above ${import.meta.dir}`,
	);
}

/**
 * The sandbox gate's own result. Its `args` already end with the unsandboxed
 * command, so the launcher forwards it verbatim and never rebuilds argv.
 */
export type SandboxLaunchPlan = Pick<SandboxLaunch, "command" | "args">;

/** Env var carrying the layout env JSON to the shim; deleted before the payload spawns. */
const SHIM_ENV_CARRIER = "OH_MY_AGENT_SHIM_ENV";

/**
 * Shared source lines of a spawn shim: re-exec `argv` with the layout's exact
 * env map, inherit stdio, forward termination signals, exit with the child.
 *
 * The env handling is the T-1005 allowlist enforcement point. `RpcClient`
 * spawns `bun <shim> …` with `env: { ...Bun.env, ...options.env }`
 * (rpc-client.ts:306), so the launcher passes the exact child env as JSON in
 * the OH_MY_AGENT_SHIM_ENV carrier — the shim process still inherits every
 * host secret, but its re-exec hands the grandchild exactly the carrier map
 * and nothing else. Blank overrides cannot prove this: they would leave an
 * undeclared var present (empty) rather than absent.
 *
 * The map is NOT baked into this file: layout.env carries the per-worker
 * inference bearer, and the materializer contract is that the bearer is
 * passed through env and never written to disk. The carrier lives only in
 * the shim's own process env, is deleted before the payload spawns, and a
 * missing or malformed carrier fails the launch closed.
 */
function shimSource(argv: string[]): string {
	return [
		"// Generated by oh-my-agent. Rebuilt on every spawn; edits are discarded.",
		`const argv = ${JSON.stringify(argv)};`,
		`const carrier = process.env[${JSON.stringify(SHIM_ENV_CARRIER)}];`,
		`delete process.env[${JSON.stringify(SHIM_ENV_CARRIER)}];`,
		"if (!carrier) {",
		'\tconsole.error("oh-my-agent: shim env carrier missing; refusing to launch");',
		"\tprocess.exit(1);",
		"}",
		"let env: Record<string, string>;",
		"try {",
		"\tconst parsed: unknown = JSON.parse(carrier);",
		"\tif (",
		"\t\ttypeof parsed !== 'object' ||",
		"\t\tparsed === null ||",
		"\t\tArray.isArray(parsed) ||",
		"\t\tObject.values(parsed).some((v) => typeof v !== 'string')",
		"\t) {",
		"\t\tthrow new Error('not a string map');",
		"\t}",
		"\tenv = parsed as Record<string, string>;",
		"} catch (error) {",
		"\tconsole.error('oh-my-agent: shim env carrier malformed:', error);",
		"\tprocess.exit(1);",
		"}",
		"const child = Bun.spawn([...argv, ...process.argv.slice(2)], {",
		"\tenv,",
		'\tstdin: "inherit",',
		'\tstdout: "inherit",',
		'\tstderr: "inherit",',
		"});",
		"",
		"// The parent kills this shim; `ptree` is documented to tree-kill, but",
		"// forwarding costs nothing and guarantees the sandboxed grandchild dies",
		"// even if that guarantee ever narrows.",
		'for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {',
		"\tprocess.on(signal, () => {",
		"\t\ttry {",
		"\t\t\tchild.kill(signal);",
		"\t\t} catch {}",
		"\t});",
		"}",
		"",
		"process.exit(await child.exited);",
		"",
	].join("\n");
}

/**
 * Write the direct-launch env shim. `RpcClient` merges the spawn env over
 * `Bun.env` and offers no wrapper hook, so the only way to keep an undeclared
 * host var out of the child is a controlled re-exec: the child is this shim,
 * and the real CLI runs as its grandchild under exactly `layout.env`.
 */
async function writeEnvShim(
	layout: WorkerLayout,
	entry: string,
): Promise<string> {
	const shimPath = join(layout.root, "env-shim.ts");
	await writeFile(shimPath, shimSource(["bun", entry]), "utf8");
	return shimPath;
}

/**
 * Write a shim that re-execs under the sandbox.
 *
 * `plan` is the full result of `resolveSandboxLaunch`, whose `args` already
 * end with the unsandboxed command (`bun <cliPath>`). `RpcClient` spawns
 * `bun <shim> <rpcArgs>` and passes only the arguments *after* the CLI path,
 * so the shim appends those to the gate's complete argv. The sandboxed
 * grandchild gets the same allowlisted env as the direct path — the gate must
 * not reintroduce the host env.
 */
async function writeSandboxShim(
	layout: WorkerLayout,
	plan: SandboxLaunchPlan,
): Promise<string> {
	const shimPath = join(layout.root, "sandbox-shim.ts");
	await writeFile(shimPath, shimSource([plan.command, ...plan.args]), "utf8");
	return shimPath;
}

/**
 * The sandbox policy a peer runs under. Exported so tests exercise the same
 * construction production uses — a duplicated policy in a test can pass while
 * this one drifts.
 */
export function buildWorkerPolicy(
	peer: PeerDefinition,
	layout: WorkerLayout,
	cwd: string,
): SandboxPolicy {
	const extraRoots =
		typeof peer.sandbox === "object" && Array.isArray(peer.sandbox.extraRoots)
			? peer.sandbox.extraRoots
			: [];
	return {
		workspace: cwd,
		workerHome: layout.home,
		runtimePaths: ["/usr/bin", "/bin", "/usr/lib"],
		inferenceGateway: layout.inferenceGateway,
		loopbackPorts: [layout.inferenceGateway.port],
		extraRoots,
	};
}

/**
 * Gate an opted-in peer: probe the adapter and gateway bridge, compile its
 * policy, and return the argv. Fails closed — an opted-in agent never
 * downgrades to an unsandboxed launch.
 */
async function gatePeer(
	peer: PeerDefinition,
	layout: WorkerLayout,
	cwd: string,
	options: StartWorkerOptions,
): Promise<SandboxLaunchPlan> {
	const adapter = options.sandboxAdapter ?? {};
	return await resolveSandboxLaunch({
		policy: buildWorkerPolicy(peer, layout, cwd),
		command: ["bun", options.cliPath ?? resolveOmpCli()],
		platform: adapter.platform ?? process.platform,
		...(adapter.which ? { which: adapter.which } : { which: defaultWhich }),
		...(adapter.probeBridge ? { probeBridge: adapter.probeBridge } : {}),
		...(adapter.adapterCommand
			? { adapterCommand: adapter.adapterCommand }
			: {}),
	});
}

/** Real adapter lookup. */
async function defaultWhich(binary: string): Promise<string | null> {
	return Bun.which(binary);
}

export async function startWorker(
	options: StartWorkerOptions,
): Promise<WorkerHandle> {
	const { peer, layout, cwd, cliPath } = options;
	const turnTimeoutMs = options.turnTimeoutMs ?? 60_000;

	// §7:141 — layer 1 is opt-in, but an opted-in peer must be gated here
	// rather than trusting a caller to hand in a plan. `sandbox: false` and an
	// omitted key both stay unsandboxed.
	const wantsSandbox =
		peer.sandbox === true ||
		(typeof peer.sandbox === "object" && peer.sandbox.enabled !== false);
	const sandbox = wantsSandbox
		? await gatePeer(peer, layout, cwd, options)
		: undefined;
	const fingerprint = fingerprintPeerDefinition(peer);
	const toolListeners = new Set<(name: string) => void>();
	const eventListeners = new Set<(event: unknown) => void>();

	let state: WorkerState = "stopped";
	let client: RpcClient | undefined;
	let sessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;

	const launch = async (): Promise<void> => {
		// `RpcClient` spawns `bun <cliPath> …` with no wrapper hook, so both the
		// sandbox and the env allowlist are applied by pointing `cliPath` at a
		// shim that re-execs the real CLI — under the compiled profile when
		// gated, always with exactly `layout.env` (T-1005). The gate has
		// already probed the adapter and the gateway bridge, so reaching here
		// with `sandbox` set means both hold.
		const entry = sandbox
			? await writeSandboxShim(layout, sandbox)
			: await writeEnvShim(layout, cliPath ?? resolveOmpCli());

		const next = new RpcClient({
			cwd,
			env: {
				// The exact child env rides the OH_MY_AGENT_SHIM_ENV carrier to the
				// shim; the shim deletes the carrier and spawns the payload with
				// only the parsed map. Kept out of WorkerLayout.env so the bearer
				// never lands in a serialized shim file or the handle's env.
				...layout.env,
				[SHIM_ENV_CARRIER]: JSON.stringify(layout.env),
			},
			sessionDir: layout.sessionDir,
			// Both resolve to the gateway provider declared in the worker's
			// models.yml, so every turn leaves through the credential gateway.
			provider: layout.provider,
			model: layout.modelId,
			cliPath: entry,
			// No `--agent` flag exists (verified via `omp --help`): the worker's
			// definition reaches the child through its materialized agent dir
			// (PI_CODING_AGENT_DIR); its body is appended as the system prompt.
			args: ["--append-system-prompt", peer.body],
		});

		// Subscribe before start so no early dispatch is missed.
		unsubscribe = next.onEvent((event) => {
			for (const listener of eventListeners) listener(event);
			// The RPC layer emits `tool_execution_*`, not raw provider toolcall
			// events (rpc-client.ts:106-117).
			if ((event as { type?: string }).type !== "tool_execution_start") return;
			const name = (event as { toolName?: unknown }).toolName;
			if (typeof name === "string")
				for (const listener of toolListeners) listener(name);
		});

		await next.start();
		client = next;
		sessionId = (await next.getState()).sessionId;
		state = "running";
	};
	const teardown = async (): Promise<void> => {
		unsubscribe?.();
		unsubscribe = undefined;
		sessionId = undefined;
		const current = client;
		client = undefined;
		if (current) await current.stop();
	};

	await launch();

	return {
		name: peer.name,
		sandboxed: sandbox !== undefined,
		get state() {
			return state;
		},
		get sessionId() {
			return sessionId;
		},
		get pid() {
			return client?.pid;
		},
		layout,
		env: layout.env,
		fingerprint,
		stderr: () => client?.getStderr() ?? "",
		effectiveTools: async () => {
			if (!client) throw new Error(`Worker ${peer.name} is ${state}`);
			const sessionState = await client.getState();
			return (sessionState.dumpTools ?? []).map((tool) => tool.name);
		},
		onEvent: (listener) => {
			eventListeners.add(listener);
			return () => {
				eventListeners.delete(listener);
			};
		},
		onToolCall: (listener) => {
			toolListeners.add(listener);
			return () => {
				toolListeners.delete(listener);
			};
		},
		prompt: async (message) => {
			if (!client)
				throw new Error(`Worker ${peer.name} is ${state}; cannot prompt`);
			// Wait for idle: callers observing tool dispatches need the turn
			// settled before they assert on what the child actually called.
			await client.promptAndWait(message, undefined, turnTimeoutMs);
		},
		park: async () => {
			if (state !== "running") return;
			await teardown();
			state = "parked";
		},
		resume: async () => {
			if (state === "running") return;
			if (state === "stopped") {
				throw new Error(
					`Worker ${peer.name} is stopped; materialize a fresh one`,
				);
			}
			await launch();
		},
		stop: async () => {
			if (state === "stopped") return;
			await teardown();
			state = "stopped";
		},
	};
}

// ── In-process backend (T-1006) ─────────────────────────────────────────────
//
// An alternative to `startWorker`'s RPC subprocess: the peer runs as an OMP
// `AgentSession` inside the daemon's own process, via `createAgentSession`
// from `@oh-my-pi/pi-coding-agent/sdk`. Selected only when the daemon boots
// with `inProcessWorkers: true` (`src/daemon/main.ts`); RPC remains the
// default.
//
// Boundary this backend does NOT have, compared to the RPC path:
//   - No materialized synthetic root (§5.2): no per-worker HOME/XDG tree, no
//     `env-shim.ts`/`sandbox-shim.ts`, no `OH_MY_AGENT_SHIM_ENV` carrier.
//   - No per-worker credential token is *constructed*: `handle.env` is `{}`
//     because there is no child env to build. But the session runs INSIDE the
//     daemon process: its tools (and any process they spawn) read the
//     daemon's ambient `process.env` directly — operator provider keys, and
//     any `OH_MY_AGENT_*` values the daemon itself was launched with, are
//     reachable. There is nothing to allowlist because there is no boundary;
//     this is the reason the backend is opt-in and RPC stays the default.
//   - `cwd`/tool visibility/auth boundary is the *daemon's own*: the session
//     runs with the daemon process's env, so provider credentials resolve
//     however OMP's own auth discovery resolves them in that process, and
//     the tool surface is whatever OMP discovers under the supplied `cwd`
//     and `agentDir` — there is no per-peer deny-list synthesized here.
//   - `sandboxed` is always `false`: there is no shell-level sandbox for a
//     session living inside the daemon's own process, so `peer.sandbox` is
//     never gated on this path.
//   - `pid` is always `undefined`: there is no OS child process.
//
// Callers (the daemon) are responsible for choosing this backend only for
// peers whose trust model tolerates running inside the daemon process — with
// the daemon's env, filesystem defaults, and credentials in reach.

/** Env var that forces `startInProcessWorker` to refuse — test-only kill switch. */
const FORCE_INPROC_DISABLED_ENV = "OMA_FORCE_INPROC_DISABLED";

/** Minimal surface of an OMP `AgentSession` this backend depends on. */
interface InProcessSession {
	readonly sessionId: string;
	readonly sessionManager?: SessionManager;
	prompt(text: string): Promise<boolean>;
	subscribe(listener: (event: unknown) => void): () => void;
	subscribeRunState(listener: (state: "running" | "idle") => void): () => void;
	beginDispose(): void;
	dispose(): Promise<void>;
}

export interface InProcessWorkerOptions {
	peer: PeerDefinition;
	/** Project directory the worker edits. There is no separate synthetic root. */
	cwd: string;
	/** OMP agent dir passed straight through to `createAgentSession`. */
	agentDir: string;
	/**
	 * Fingerprint of the definition this worker was built from. Supplied by
	 * the caller (daemon) so `recordRuns`/the supervisor's staleness check
	 * see the same value the RPC path would compute.
	 */
	fingerprint: string;
	/** SDK seam — defaults to the real `createAgentSession`; overridable for tests. */
	createSession?: (
		options: CreateAgentSessionOptions,
	) => Promise<CreateAgentSessionResult>;
	/** Per-turn ceiling for a prompt round-trip. */
	turnTimeoutMs?: number;
	/** Appended as the session's system prompt; mirrors RPC's `--append-system-prompt`. */
	appendSystemPrompt?: string;
	/** Raw model pattern (e.g. the peer's `model:` frontmatter). */
	modelPattern?: string;
	/** Comma-joined spawns closure, forwarded to `createAgentSession`. */
	spawns?: string;
	/** Unique per-session agent identity; avoids the "Main replaced" registry race. */
	agentId?: string;
	/**
	 * Reused across park/resume. OMP keeps the session storage it owns behind
	 * this manager, so recreating a session with the same manager preserves
	 * transcript/artifact storage where the SDK permits it.
	 */
	sessionManager?: SessionManager;
}

async function defaultCreateSession(
	options: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
	return await createAgentSession(options);
}

export async function startInProcessWorker(
	options: InProcessWorkerOptions,
): Promise<WorkerHandle> {
	if (process.env[FORCE_INPROC_DISABLED_ENV]) {
		throw new Error(
			"in-process worker backend is disabled (OMA_FORCE_INPROC_DISABLED set)",
		);
	}

	const { peer, cwd, agentDir, fingerprint } = options;
	const turnTimeoutMs = options.turnTimeoutMs ?? 60_000;
	const createSession = options.createSession ?? defaultCreateSession;

	// No materializer synthetic root: the project cwd doubles as both `root`
	// and `home` in the synthetic layout, since there is no separate HOME
	// tree to point at. `env` is always empty — see the boundary note above.
	const layout: WorkerLayout = {
		root: cwd,
		home: cwd,
		agentDir,
		sessionDir: cwd,
		generatedAgentPath: "",
		configPath: "",
		modelsPath: "",
		provider: "",
		modelId: "",
		inferenceGateway: { host: "127.0.0.1", port: 0 },
		skillPaths: [],
		disabledAgents: [],
		definitionFingerprint: fingerprint,
		env: {},
	};

	let state: WorkerState = "stopped";
	let session: InProcessSession | undefined;
	// Captured at launch; reused across park/resume so the SDK keeps the
	// same on-disk session storage where it permits. Falls back to the
	// caller's `options.sessionManager` when the SDK does not expose one.
	let activeSessionManager: SessionManager | undefined = options.sessionManager;
	let eventUnsubscribe: (() => void) | undefined;
	const toolListeners = new Set<(name: string) => void>();
	const eventListeners = new Set<(event: unknown) => void>();

	const buildSessionOptions = (): CreateAgentSessionOptions => ({
		cwd,
		agentDir,
		spawns: options.spawns,
		modelPattern: options.modelPattern,
		appendSystemPrompt: options.appendSystemPrompt,
		agentId: options.agentId ?? peer.name,
		...(activeSessionManager ? { sessionManager: activeSessionManager } : {}),
	});

	const launch = async (): Promise<void> => {
		const result = await createSession(buildSessionOptions());
		const next = result.session as unknown as InProcessSession;
		activeSessionManager ??= next.sessionManager;

		eventUnsubscribe = next.subscribe((event) => {
			for (const listener of eventListeners) listener(event);
			const type = (event as { type?: string }).type;
			if (type !== "tool_execution_start") return;
			const name = (event as { toolName?: unknown }).toolName;
			if (typeof name === "string")
				for (const listener of toolListeners) listener(name);
		});

		session = next;
		state = "running";
	};

	const teardown = async (): Promise<void> => {
		eventUnsubscribe?.();
		eventUnsubscribe = undefined;
		const current = session;
		session = undefined;
		if (current) {
			current.beginDispose();
			await current.dispose();
		}
	};

	await launch();

	return {
		name: peer.name,
		// In-process has no shell-level sandbox: the field is hard-wired to
		// `false` regardless of `peer.sandbox`.
		sandboxed: false,
		get state() {
			return state;
		},
		get sessionId() {
			return session?.sessionId;
		},
		// No OS child process backs this worker.
		get pid() {
			return undefined;
		},
		layout,
		env: layout.env,
		fingerprint,
		// No subprocess stderr to read; nothing failed at the process level.
		stderr: () => "",
		effectiveTools: async () => {
			if (!session) throw new Error(`Worker ${peer.name} is ${state}`);
			// Known limitation: the SDK does not expose an RPC-style
			// `dumpTools` snapshot on this path. Callers that need the
			// worker's actual tool surface must use the RPC backend.
			return [];
		},
		onEvent: (listener) => {
			eventListeners.add(listener);
			return () => {
				eventListeners.delete(listener);
			};
		},
		onToolCall: (listener) => {
			toolListeners.add(listener);
			return () => {
				toolListeners.delete(listener);
			};
		},
		prompt: async (message) => {
			if (!session)
				throw new Error(`Worker ${peer.name} is ${state}; cannot prompt`);
			const current = session;

			// Wait for the terminal `idle` run-state transition after the
			// prompt resolves, the same "settled before returning" contract
			// `RpcClient.promptAndWait` gives the RPC path.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<void>((resolve, reject) => {
				const unsubscribe = current.subscribeRunState((runState) => {
					if (runState !== "idle") return;
					if (timer !== undefined) clearTimeout(timer);
					unsubscribe();
					resolve();
				});
				timer = setTimeout(() => {
					unsubscribe();
					reject(
						new Error(
							`Worker ${peer.name} did not go idle within ${turnTimeoutMs}ms`,
						),
					);
				}, turnTimeoutMs);
			});

			try {
				await current.prompt(message);
				await idle;
			} finally {
				// A rejecting prompt or a timed-out idle must not leave a live
				// timer behind in the daemon process (shared memory — an
				// orphaned rejection here is everyone's crash).
				if (timer !== undefined) clearTimeout(timer);
				idle.catch(() => {});
			}
		},
		park: async () => {
			if (state !== "running") return;
			await teardown();
			state = "parked";
		},
		resume: async () => {
			if (state === "running") return;
			if (state === "stopped") {
				throw new Error(
					`Worker ${peer.name} is stopped; materialize a fresh one`,
				);
			}
			await launch();
		},
		stop: async () => {
			if (state === "stopped") return;
			await teardown();
			state = "stopped";
		},
	};
}
