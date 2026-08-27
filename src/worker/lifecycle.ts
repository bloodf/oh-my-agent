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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

import { resolveSandboxLaunch } from "./launch-gate";
import type { SandboxLaunch } from "./launch-gate";
import type { SandboxPolicy } from "./sandbox";

import type { WorkerLayout } from "../daemon/materializer";
import type { PeerDefinition } from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";

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
	return Array.isArray(payload.rooms) && payload.rooms.length > 0 ? "peer" : "subtask";
}

/**
 * Absolute path to the installed OMP CLI. `RpcClient` defaults to a
 * cwd-relative `dist/cli.js`, which only resolves inside an OMP checkout — the
 * worker's cwd is the user's project.
 */
function resolveOmpCli(): string {
	return fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/package.json")).replace(
		/package\.json$/,
		"dist/cli.js",
	);
}

/**
 * The sandbox gate's own result. Its `args` already end with the unsandboxed
 * command, so the launcher forwards it verbatim and never rebuilds argv.
 */
export type SandboxLaunchPlan = Pick<SandboxLaunch, "command" | "args">;

/**
 * Write a shim that re-execs under the sandbox.
 *
 * `plan` is the full result of `resolveSandboxLaunch`, whose `args` already
 * end with the unsandboxed command (`bun <cliPath>`). `RpcClient` spawns
 * `bun <shim> <rpcArgs>` and passes only the arguments *after* the CLI path,
 * so the shim appends those to the gate's complete argv.
 */
async function writeSandboxShim(layout: WorkerLayout, plan: SandboxLaunchPlan): Promise<string> {
	const shimPath = join(layout.root, "sandbox-shim.ts");
	const source = [
		"// Generated by oh-my-agent. Re-execs the OMP CLI under the worker's",
		"// compiled sandbox profile; rebuilt on every spawn.",
		`const argv = ${JSON.stringify([plan.command, ...plan.args])};`,
		"const child = Bun.spawn([...argv, ...process.argv.slice(2)], {",
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
	await writeFile(shimPath, source, "utf8");
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
		...(adapter.adapterCommand ? { adapterCommand: adapter.adapterCommand } : {}),
	});
}

/** Real adapter lookup. */
async function defaultWhich(binary: string): Promise<string | null> {
	return Bun.which(binary);
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
	const { peer, layout, cwd, cliPath } = options;
	const turnTimeoutMs = options.turnTimeoutMs ?? 60_000;

	// §7:141 — layer 1 is opt-in, but an opted-in peer must be gated here
	// rather than trusting a caller to hand in a plan. `sandbox: false` and an
	// omitted key both stay unsandboxed.
	const wantsSandbox =
		peer.sandbox === true || (typeof peer.sandbox === "object" && peer.sandbox.enabled !== false);
	const sandbox = wantsSandbox ? await gatePeer(peer, layout, cwd, options) : undefined;
	const fingerprint = fingerprintPeerDefinition(peer);
	const toolListeners = new Set<(name: string) => void>();
	const eventListeners = new Set<(event: unknown) => void>();

	let state: WorkerState = "stopped";
	let client: RpcClient | undefined;
	let sessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;

	const launch = async (): Promise<void> => {
		// `RpcClient` spawns `bun <cliPath> …` with no wrapper hook, so the
		// sandbox is applied by pointing `cliPath` at a shim that re-execs the
		// real CLI under the compiled profile. The gate has already probed the
		// adapter and the gateway bridge, so reaching here means both hold.
		const entry = sandbox ? await writeSandboxShim(layout, sandbox) : (cliPath ?? resolveOmpCli());

		const next = new RpcClient({
			cwd,
			env: layout.env,
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
			if (typeof name === "string") for (const listener of toolListeners) listener(name);
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
			if (!client) throw new Error(`Worker ${peer.name} is ${state}; cannot prompt`);
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
				throw new Error(`Worker ${peer.name} is stopped; materialize a fresh one`);
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
