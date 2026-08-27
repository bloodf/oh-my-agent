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
import { fileURLToPath } from "node:url";

import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

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
	/** Per-turn ceiling for a prompt round-trip. */
	turnTimeoutMs?: number;
}

export type WorkerState = "running" | "parked" | "stopped";

export interface WorkerHandle {
	readonly name: string;
	readonly state: WorkerState;
	/** Live child's session id; undefined once parked or stopped. */
	readonly sessionId: string | undefined;
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

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
	const { peer, layout, cwd, cliPath } = options;
	const turnTimeoutMs = options.turnTimeoutMs ?? 60_000;
	const fingerprint = fingerprintPeerDefinition(peer);
	const toolListeners = new Set<(name: string) => void>();
	const eventListeners = new Set<(event: unknown) => void>();

	let state: WorkerState = "stopped";
	let client: RpcClient | undefined;
	let sessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;

	const launch = async (): Promise<void> => {
		const next = new RpcClient({
			cwd,
			env: layout.env,
			sessionDir: layout.sessionDir,
			// Both resolve to the gateway provider declared in the worker's
			// models.yml, so every turn leaves through the credential gateway.
			provider: layout.provider,
			model: layout.modelId,
			cliPath: cliPath ?? resolveOmpCli(),
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
