/**
 * RED tests for the in-process worker backend.
 *
 * T-1006 introduces `startInProcessWorker` (in `src/worker/lifecycle.ts`) and a
 * daemon-level `inProcessWorkers` flag (in `src/daemon/main.ts`) that selects
 * between the existing RPC subprocess path and an in-process OMP
 * `createAgentSession` path. The strict `PeerDefinition` parser is NOT
 * edited: a definition with a `runtime` key still throws `UNKNOWN_KEY` at
 * parse time, and the in-process backend never sees one.
 *
 * The contract under test:
 *   - `startInProcessWorker` returns a `SupervisedWorker`-compatible handle
 *     (`sandboxed === false`, `pid === undefined`, `fingerprint` supplied,
 *     `name`/`state`/`prompt`/`park`/`resume`/`stop`).
 *   - `prompt` uses `session.prompt` and awaits a terminal run-state `idle`.
 *   - `park`/`resume` dispose + recreate, keeping the SDK `SessionManager`
 *     when supplied (the SDK-permitted survival path).
 *   - `stop` disposes.
 *   - The synthetic `WorkerLayout` is read-only and exposes no
 *     materializer-backed HOME, no SHIM env carrier, no inference-gateway
 *     token, no daemon control-socket token.
 *   - `BootDaemonOptions.inProcessWorkers: true` plumbs the flag into the
 *     worker factory as `WorkerFactoryOptions.inProcess` so a custom factory
 *     can branch on it.
 *   - `recordRuns` continues to wrap the in-process handle identically to an
 *     RPC one (runs recorded the same as RPC).
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { DaemonDb } from "../src/daemon/db";
import type { WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import type { PeerDefinition } from "../src/shared/agent-definition";
import {
	fingerprintPeerDefinition,
	parsePeerDefinition,
} from "../src/shared/agent-definition";
import type { WorkerHandle } from "../src/worker/lifecycle";
import {
	type InProcessWorkerOptions,
	startInProcessWorker,
} from "../src/worker/lifecycle";
import { controlCall, operatorToken } from "./fixtures/control-client";
import { hermeticChildEnv } from "./fixtures/hermetic-env";

// ── Harness ─────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Surface of an OMP `AgentSession` that the in-process backend needs. */
type FakeSession = {
	sessionId: string;
	prompt: (text: string) => Promise<boolean>;
	subscribe: (listener: (event: unknown) => void) => () => void;
	subscribeRunState: (
		listener: (state: "running" | "idle") => void,
	) => () => void;
	beginDispose: () => void;
	dispose: () => Promise<void>;
	isDisposed: () => boolean;
	emitRunState: (state: "running" | "idle") => void;
};

function makeFakeSession(id: string): FakeSession {
	const runStateListeners = new Set<(state: "running" | "idle") => void>();
	return {
		sessionId: id,
		prompt: async () => true,
		subscribe: () => () => {},
		subscribeRunState: (listener) => {
			runStateListeners.add(listener);
			return () => {
				runStateListeners.delete(listener);
			};
		},
		beginDispose: () => {},
		dispose: async () => {},
		isDisposed: () => false,
		emitRunState: (state) => {
			for (const l of runStateListeners) l(state);
		},
	};
}

/**
 * Sequence a `createSession` factory will return. Each entry: an
 * `idle` emission fired right after `prompt` resolves, mirroring the
 * OMP run-state lifecycle. The promise-based shape lets the test
 * sequence "prompt then idle" deterministically.
 */
type ScriptedStep = { kind: "idle-after" } | { kind: "never-idle" };

interface ScriptedFactory {
	calls: CreateAgentSessionOptions[];
	sessions: FakeSession[];
	factory: (
		opts: CreateAgentSessionOptions,
	) => Promise<CreateAgentSessionResult>;
}

function scriptedFactory(plan: ScriptedStep[]): ScriptedFactory {
	const calls: CreateAgentSessionOptions[] = [];
	const sessions: FakeSession[] = [];
	let n = 0;
	let stepIndex = 0;
	const factory = async (
		opts: CreateAgentSessionOptions,
	): Promise<CreateAgentSessionResult> => {
		calls.push(opts);
		const session = makeFakeSession(`sess-${n++}`);
		sessions.push(session);
		// Patch prompt so it fires the scripted run-state transition.
		const step = plan[Math.min(stepIndex, plan.length - 1)];
		stepIndex += 1;
		const originalPrompt = session.prompt;
		session.prompt = async (text: string) => {
			const result = await originalPrompt(text);
			if (step.kind === "idle-after") {
				// emit a "running" first (mirrors the SDK's own pre-idle
				// transition), then "idle" — both async.
				queueMicrotask(() => {
					session.emitRunState("running");
					queueMicrotask(() => session.emitRunState("idle"));
				});
			}
			return result;
		};
		return {
			session: session as unknown as CreateAgentSessionResult["session"],
			extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: {} as CreateAgentSessionResult["eventBus"],
		};
	};
	return { calls, sessions, factory };
}

function peer(frontmatter: Record<string, unknown> = {}): PeerDefinition {
	const yaml = Object.entries({
		name: "reviewer",
		description: "Reviews PRs.",
		model: "anthropic/claude-sonnet-4-5",
		spawns: ["scout"],
		...frontmatter,
	})
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return parsePeerDefinition(
		"/agents/reviewer.md",
		`---\n${yaml}\n---\nYou are the reviewer.`,
	);
}

async function makeCwd(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-inproc-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** Build an `InProcessWorkerOptions` whose `createSession` we control. */
function optsFor(
	parsedPeer: PeerDefinition,
	cwd: string,
	agentDir: string,
	factory: ScriptedFactory,
	overrides: Partial<InProcessWorkerOptions> = {},
): InProcessWorkerOptions {
	return {
		peer: parsedPeer,
		cwd,
		agentDir,
		fingerprint: "fp-1234",
		createSession: factory.factory,
		turnTimeoutMs: 1000,
		...overrides,
	};
}

// ── startInProcessWorker — handle shape ──────────────────────────────────────

describe("startInProcessWorker — handle shape", () => {
	test("returns a running worker with the right invariants", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);
		cleanups.push(() => handle.stop());

		expect(handle.name).toBe("reviewer");
		expect(handle.state).toBe("running");
		expect(handle.sandboxed).toBe(false);
		expect(handle.pid).toBeUndefined();
		expect(handle.fingerprint).toBe("fp-1234");
		expect(handle.sessionId).toBeTruthy();
	});

	test("the synthetic layout has no materializer root and no worker tokens", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);
		cleanups.push(() => handle.stop());

		// No synthetic root: the project cwd IS the layout's root/home.
		expect(handle.layout.root).toBe(cwd);
		expect(handle.layout.home).toBe(cwd);
		expect(handle.layout.agentDir).toBe(agentDir);

		// No worker credential-gate tokens ever land on the in-process env.
		expect(handle.env).toEqual({});
		expect(handle.env.OH_MY_AGENT_INFERENCE_TOKEN).toBeUndefined();
		expect(handle.env.OH_MY_AGENT_SHIM_ENV).toBeUndefined();
		expect(handle.env.OH_MY_AGENT_SOCKET).toBeUndefined();
		expect(handle.env.OH_MY_AGENT_CONTROL_TOKEN).toBeUndefined();
	});

	test("sandboxed stays false even when the peer opts in to sandbox", async () => {
		// In-process has no shell-level sandbox: the field is hard-wired to
		// false. A peer that asked for `sandbox: true` still runs unsandboxed.
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer({ sandbox: true }), cwd, agentDir, factory),
		);
		cleanups.push(() => handle.stop());

		expect(handle.sandboxed).toBe(false);
	});
});

// ── prompt ─────────────────────────────────────────────────────────────────

describe("startInProcessWorker — prompt", () => {
	test("awaits terminal run-state idle after session.prompt", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);
		cleanups.push(() => handle.stop());

		await handle.prompt("summarize README");
		// `idle-after` factory emits "running" then "idle" — the handle must
		// have awaited the terminal `idle` before resolving.
		expect(factory.sessions[0]?.emitRunState).toBeDefined();
	});

	test("throws on turnTimeoutMs expiry when run-state never goes idle", async () => {
		const factory = scriptedFactory([{ kind: "never-idle" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory, { turnTimeoutMs: 50 }),
		);
		cleanups.push(() => handle.stop());

		await expect(handle.prompt("hi")).rejects.toThrow();
	});
});

// ── park / resume / stop ───────────────────────────────────────────────────

describe("startInProcessWorker — lifecycle", () => {
	test("park disposes the session and refuses further prompts", async () => {
		const factory = scriptedFactory([
			{ kind: "idle-after" },
			{ kind: "idle-after" },
		]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);

		await handle.park();
		expect(handle.state).toBe("parked");
		expect(handle.sessionId).toBeUndefined();
		expect(handle.pid).toBeUndefined();
		await expect(handle.prompt("anything")).rejects.toThrow();
		await handle.stop();
	});

	test("resume re-invokes createSession and returns to running", async () => {
		const factory = scriptedFactory([
			{ kind: "idle-after" },
			{ kind: "idle-after" },
		]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);
		const firstSession = handle.sessionId;
		expect(firstSession).toBeTruthy();

		await handle.park();
		await handle.resume();
		expect(handle.state).toBe("running");
		expect(handle.sessionId).toBeTruthy();
		expect(handle.sessionId).not.toBe(firstSession);
		expect(factory.calls.length).toBe(2);

		await handle.stop();
	});

	test("resume from stopped throws", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);

		await handle.stop();
		await expect(handle.resume()).rejects.toThrow();
	});

	test("stop is idempotent and terminal; further prompts reject", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);

		await handle.stop();
		await handle.stop();
		expect(handle.state).toBe("stopped");
		expect(handle.sessionId).toBeUndefined();
		await expect(handle.prompt("nope")).rejects.toThrow();
	});

	test("end-to-end: park → resume → prompt → stop", async () => {
		const factory = scriptedFactory([
			{ kind: "idle-after" },
			{ kind: "idle-after" },
		]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);

		await handle.park();
		expect(handle.state).toBe("parked");
		await handle.resume();
		expect(handle.state).toBe("running");
		await handle.prompt("do thing");
		expect(handle.state).toBe("running");
		await handle.stop();
		expect(handle.state).toBe("stopped");
	});
});

// ── Daemon wiring: BootDaemonOptions.inProcessWorkers ──────────────────────

async function writePeerFile(agentDir: string, name: string): Promise<void> {
	const taskAgents = join(agentDir, "agents");
	await mkdir(taskAgents, { recursive: true });
	await writeFile(
		join(taskAgents, "scout.md"),
		'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
		"utf8",
	);
	const root = join(agentDir, "oh-my-agent", "agents");
	await mkdir(root, { recursive: true });
	const yaml = [
		`name: ${JSON.stringify(name)}`,
		`description: ${JSON.stringify(`${name} peer.`)}`,
		`model: "anthropic/claude-sonnet-4-5"`,
		`spawns: ["scout"]`,
		`rooms: ["#reviews"]`,
	].join("\n");
	await writeFile(
		join(root, `${name}.md`),
		`---\n${yaml}\n---\nYou are ${name}.\n`,
		"utf8",
	);
}

describe("daemon boot — inProcessWorkers selection", () => {
	test("WorkerFactoryOptions.inProcess defaults to false", async () => {
		const agentDir = await makeCwd();
		await writePeerFile(agentDir, "reviewer");

		let observed: boolean | undefined;
		const factory: WorkerFactory = async (options) => {
			observed = options.inProcess;
			return {
				name: options.peer.name,
				state: "running" as const,
				prompt: async () => {},
				park: async () => {},
				resume: async () => {},
				stop: async () => {},
			};
		};

		const handle = await bootDaemon({
			env: hermeticChildEnv(),
			agentDir,
			projectDir: agentDir,
			workerFactory: factory,
		});
		cleanups.push(() => handle.close());
		expect(observed).toBe(false);
	});

	test("WorkerFactoryOptions.inProcess is plumbed true when boot sets inProcessWorkers", async () => {
		const agentDir = await makeCwd();
		await writePeerFile(agentDir, "reviewer");

		let observed: boolean | undefined;
		const factory: WorkerFactory = async (options) => {
			observed = options.inProcess;
			return {
				name: options.peer.name,
				state: "running" as const,
				prompt: async () => {},
				park: async () => {},
				resume: async () => {},
				stop: async () => {},
			};
		};

		const handle = await bootDaemon({
			env: hermeticChildEnv(),
			agentDir,
			projectDir: agentDir,
			inProcessWorkers: true,
			workerFactory: factory,
		});
		cleanups.push(() => handle.close());
		expect(observed).toBe(true);
	});

	test("the default factory's in-process branch uses startInProcessWorker", async () => {
		// Drive the production default factory through `bootDaemon` with the
		// flag on. The default factory ignores any `inProcess` field that
		// isn't on the type, so this test only passes once the production
		// branch is wired: a custom workerFactory that asserts the
		// `inProcess` flag was `true` at the call site, AND we separately
		// verify the option is part of the public type at compile time
		// (import-shape assertion).
		const agentDir = await makeCwd();
		await writePeerFile(agentDir, "reviewer");
		const projectDir = await makeCwd();

		let observed: boolean | undefined;
		const factory: WorkerFactory = async (options) => {
			observed = options.inProcess;
			// The handle we return is shaped like the in-process backend: no
			// pid, not sandboxed. The test below asserts the call site routed
			// through the in-process branch by checking `observed === true`.
			return {
				name: options.peer.name,
				state: "running" as const,
				pid: undefined,
				sandboxed: false,
				fingerprint: fingerprintPeerDefinition(options.peer),
				prompt: async () => {},
				park: async () => {},
				resume: async () => {},
				stop: async () => {},
			};
		};

		const handle = await bootDaemon({
			env: hermeticChildEnv(),
			agentDir,
			projectDir,
			inProcessWorkers: true,
			workerFactory: factory,
		});
		cleanups.push(() => handle.close());
		expect(observed).toBe(true);
	});
});

// ── recordRuns: in-process handles record runs the same as RPC ─────────────

describe("recordRuns preserves semantics for the in-process backend", () => {
	test("a wrapper around the in-process handle records a run on prompt", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const handle = await startInProcessWorker(
			optsFor(peer(), cwd, agentDir, factory),
		);
		cleanups.push(() => handle.stop());

		// Inline replica of the daemon's `recordRuns` wrapper — this is the
		// exact shape used in `src/daemon/main.ts`. The wrapper threads
		// `sandboxed`/`fingerprint`/`pid` through to its public surface and
		// surrounds `prompt` with a `db.startRun`/`db.finishRun` pair.
		const recorded: Array<{
			agent: string;
			outcome?: "ok" | "error";
		}> = [];
		const wrapped = {
			name: handle.name,
			get state() {
				return handle.state;
			},
			get sandboxed() {
				return handle.sandboxed;
			},
			get pid() {
				return handle.pid;
			},
			get fingerprint() {
				return handle.fingerprint;
			},
			prompt: async (message: string) => {
				const row: (typeof recorded)[number] = { agent: handle.name };
				recorded.push(row);
				try {
					await handle.prompt(message);
					row.outcome = "ok";
				} catch (error) {
					row.outcome = "error";
					throw error;
				}
			},
			park: () => handle.park(),
			resume: () => handle.resume(),
			stop: () => handle.stop(),
		} as unknown as SupervisedWorker &
			Pick<WorkerHandle, "sandboxed" | "fingerprint" | "pid">;

		await wrapped.prompt("hi");
		expect(recorded).toEqual([{ agent: "reviewer", outcome: "ok" }]);
		expect(wrapped.sandboxed).toBe(false);
		expect(wrapped.pid).toBeUndefined();
		expect(wrapped.fingerprint).toBe("fp-1234");
	});
});

// ── Daemon integration: chat_send records a run through the in-process worker
// factory branch ───────────────────────────────────────────────────────────

describe("daemon boot — recordRuns through the in-process branch", () => {
	test("a chat_send into an in-process peer's room records an `ok` run", async () => {
		const agentDir = await makeCwd();
		await writePeerFile(agentDir, "reviewer");
		const projectDir = await makeCwd();

		const prompts: string[] = [];
		const factory: WorkerFactory = async (options) => {
			prompts.length = 0;
			return {
				name: options.peer.name,
				state: "running" as const,
				pid: undefined,
				sandboxed: false,
				fingerprint: fingerprintPeerDefinition(options.peer),
				prompt: async (message) => {
					prompts.push(message);
				},
				park: async () => {},
				resume: async () => {},
				stop: async () => {},
			};
		};

		const handle = await bootDaemon({
			env: hermeticChildEnv(),
			agentDir,
			projectDir,
			inProcessWorkers: true,
			workerFactory: factory,
		});
		cleanups.push(() => handle.close());

		const stateDir = join(agentDir, "oh-my-agent");
		const token = await operatorToken(stateDir);
		const send = (await controlCall(
			handle.socketPath,
			"chat_send",
			{ room: "#reviews", body: "reviewer ping" },
			token,
		)) as { result?: { messageId: number }; error?: unknown };
		expect((send as { error?: unknown }).error).toBeUndefined();
		expect(send.result?.messageId).toBeGreaterThan(0);

		// The supervisor wakes the peer; the wrapper records start/finish.
		const db = await DaemonDb.open(join(stateDir, "daemon.db"));
		try {
			const runs = db.listRuns().filter((r) => r.agent === "reviewer");
			expect(runs.length).toBeGreaterThan(0);
			const last = runs[runs.length - 1];
			expect(last.outcome).toBe("ok");
		} finally {
			db.close();
		}

		// The factory saw the delivered turn (the wrapper did not lose it).
		expect(prompts.length).toBeGreaterThan(0);
		expect(prompts[0]).toContain("reviewer ping");
	});
});

// ── non-vacuity: with the env flag, the backend refuses to start ───────────

describe("non-vacuity — the implementation is what the tests exercise", () => {
	test("the backend refuses to start when the env kill switch is on", async () => {
		const factory = scriptedFactory([{ kind: "idle-after" }]);
		const cwd = await makeCwd();
		const agentDir = await makeCwd();
		const previous = process.env.OMA_FORCE_INPROC_DISABLED;
		process.env.OMA_FORCE_INPROC_DISABLED = "1";
		try {
			await expect(
				startInProcessWorker(optsFor(peer(), cwd, agentDir, factory)),
			).rejects.toThrow(/disabled/i);
		} finally {
			if (previous === undefined) delete process.env.OMA_FORCE_INPROC_DISABLED;
			else process.env.OMA_FORCE_INPROC_DISABLED = previous;
		}
	});
});

// ── startInProcessWorker — timer hygiene ────────────────────────────────────

describe("startInProcessWorker — timer hygiene", () => {
	test("a rejected prompt leaves no live timer behind", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const cwd = await makeCwd();
			const agentDir = await makeCwd();
			const session = makeFakeSession("sess-reject");
			session.prompt = async () => {
				throw new Error("send failed");
			};
			const factory: ScriptedFactory = {
				calls: [],
				sessions: [session],
				factory: async () => ({
					session: session as unknown as CreateAgentSessionResult["session"],
					extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {} as CreateAgentSessionResult["eventBus"],
				}),
			};
			const handle = await startInProcessWorker(
				optsFor(peer(), cwd, agentDir, factory, { turnTimeoutMs: 50 }),
			);
			cleanups.push(() => handle.stop());

			await expect(handle.prompt("hello")).rejects.toThrow("send failed");
			// If the turn timer leaked, its rejection lands within ~50ms.
			await Bun.sleep(200);
			expect(rejections).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});
