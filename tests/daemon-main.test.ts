/**
 * RED tests for src/daemon/main.ts and src/daemon/socket.ts (T-502).
 *
 * Public API under test: `bootDaemon(options) -> DaemonHandle` and the unix
 * socket it serves.
 *
 * This is the composition root: the point where broker hosting, the credential
 * gateway, the room store, the scheduler, the supervisor, and the peer store
 * stop being independently-tested parts and become one process a human can
 * launch. The properties that exist only here are boot order, single-instance
 * refusal, detachment from the launching terminal, and reverse-order shutdown.
 *
 * Every boot runs against a temp agent dir with `env: {}`, so broker discovery
 * finds nothing and embeds a broker over that temp dir — the real user profile
 * and the real vault are never touched.
 *
 * Every response is validated through the production `METHODS` contract rather
 * than cast into shape, so a server that answers a plausible-looking but
 * non-conforming frame fails here instead of in T-503 and T-504.
 *
 * The worker is a stub following `SupervisedWorker` (the pattern in
 * tests/supervisor.test.ts): this suite is about composition, not about the RPC
 * child, which tests/worker-lifecycle.test.ts already covers.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import { type PeerRecord, startControlSocket } from "../src/daemon/socket";
import type { SupervisedWorker, Supervisor } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";
import type {
	AgentSpawnResult,
	AgentStatusResult,
	BumpResult,
	ChatReadResult,
	ChatSendResult,
	ChatWaitResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	KillResult,
	MethodName,
	RoomsListResult,
	SchedulesArmResult,
	SchedulesListResult,
	StatusResult,
	TaskHandoffResult,
} from "../src/shared/protocol";
import { ERROR_CODE, PROTOCOL_VERSION } from "../src/shared/protocol";
import { METHODS } from "../src/shared/protocol-schemas";
import { hermeticChildEnv } from "./fixtures/hermetic-env";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-main-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Write a peer definition into the agent dir's private user store, plus the
 * task agent its `spawns:` names. Both are required: the parser rejects an
 * empty `spawns:`, and the daemon refuses to start a peer whose spawn closure
 * it cannot resolve.
 */
async function writePeer(
	agentDir: string,
	name: string,
	frontmatter: Record<string, unknown> = {},
): Promise<void> {
	const taskAgents = join(agentDir, "agents");
	await mkdir(taskAgents, { recursive: true });
	await writeFile(
		join(taskAgents, "scout.md"),
		'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
		"utf8",
	);

	const root = join(agentDir, "oh-my-agent", "agents");
	await mkdir(root, { recursive: true });
	const yaml = Object.entries({
		name,
		description: `${name} peer.`,
		model: "anthropic/claude-sonnet-4-5",
		spawns: ["scout"],
		rooms: ["#reviews"],
		...frontmatter,
	})
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	await writeFile(
		join(root, `${name}.md`),
		`---\n${yaml}\n---\nYou are ${name}.\n`,
		"utf8",
	);
}

interface StubWorker {
	prompts: string[];
	state: () => SupervisedWorker["state"];
}

/** Records what the daemon asked each worker to do. */
function stubWorkerFactory(): {
	factory: WorkerFactory;
	workers: Map<string, StubWorker>;
} {
	const workers = new Map<string, StubWorker>();

	const factory: WorkerFactory = async ({ peer }) => {
		const prompts: string[] = [];
		let state: SupervisedWorker["state"] = "running";
		workers.set(peer.name, { prompts, state: () => state });

		return {
			name: peer.name,
			get state() {
				return state;
			},
			prompt: async (message) => {
				prompts.push(message);
			},
			park: async () => {
				state = "parked";
			},
			resume: async () => {
				state = "running";
			},
			stop: async () => {
				state = "stopped";
			},
		};
	};

	return { factory, workers };
}

async function boot(
	options: { agentDir?: string; projectDir?: string } = {},
): Promise<{
	handle: DaemonHandle;
	agentDir: string;
	workers: Map<string, StubWorker>;
}> {
	const agentDir = options.agentDir ?? (await tempAgentDir());
	const projectDir = options.projectDir ?? (await tempAgentDir());
	const stub = stubWorkerFactory();

	const handle = await bootDaemon({
		env: {},
		agentDir,
		projectDir,
		workerFactory: stub.factory,
	});
	cleanups.push(() => handle.close());

	return { handle, agentDir, workers: stub.workers };
}

/** One JSON-RPC round trip over the daemon's unix socket. */
async function rpc(
	socketPath: string,
	method: string,
	params?: unknown,
	id: number | string = 1,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
	const res = await fetch("http://localhost/rpc", {
		unix: socketPath,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	return (await res.json()) as JsonRpcSuccess | JsonRpcFailure;
}

/**
 * Call a method and validate its result through the shared contract before
 * handing it back typed. Every success assertion in this file goes through
 * here, so a result that drifts from `METHODS` fails at the call site rather
 * than being cast into a shape it does not have.
 */
async function call<T>(
	socketPath: string,
	method: MethodName,
	params?: unknown,
	id: number | string = 1,
): Promise<T> {
	const frame = await rpc(socketPath, method, params, id);
	if ("error" in frame) {
		throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`);
	}
	const validated = METHODS[method].validateResult(frame.result);
	if (!validated.ok) {
		throw new Error(
			`${method} result violates its contract at ${validated.field}: ${validated.message}`,
		);
	}
	return validated.value as T;
}

function expectFailure(frame: JsonRpcSuccess | JsonRpcFailure): JsonRpcFailure {
	if (!("error" in frame)) {
		throw new Error(`Expected failure, got success: ${JSON.stringify(frame)}`);
	}
	return frame;
}

/**
 * Poll `probe` until it returns a value. Used only where the thing awaited is
 * another OS process reaching a state this process cannot observe directly.
 */
async function until<T>(
	probe: () => Promise<T | undefined> | T | undefined,
	description: string,
	attempts = 100,
): Promise<T> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const value = await probe();
		if (value !== undefined) return value;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${description}`);
}

// ── Boot and the served socket ───────────────────────────────────────────────

describe("bootDaemon — composition and the control socket", () => {
	test("boots and answers a status request over the unix socket", async () => {
		const { handle, agentDir } = await boot();

		expect(handle.socketPath).toBe(
			join(agentDir, "oh-my-agent", "daemon.sock"),
		);
		expect(existsSync(handle.socketPath)).toBe(true);

		const status = await call<StatusResult>(handle.socketPath, "status");
		expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
		expect(status.agents).toEqual([]);
	});

	test("boot honors the agent dir it is given for socket and pidfile", async () => {
		const agentDir = await tempAgentDir();
		const { handle } = await boot({ agentDir });

		expect(handle.socketPath.startsWith(agentDir)).toBe(true);
		expect(handle.pidPath).toBe(join(agentDir, "oh-my-agent", "daemon.pid"));
		expect(await Bun.file(handle.pidPath).text()).toBe(String(process.pid));
	});

	test("an empty peer store is zero peers, not a boot failure", async () => {
		const { handle } = await boot();
		const status = await call<AgentStatusResult>(
			handle.socketPath,
			"agent_status",
		);
		expect(status.agents).toEqual([]);
	});

	test("reports actual sandbox state through status and agent_status", async () => {
		const dir = await tempAgentDir();
		const rooms = await RoomStore.open(join(dir, "status.db"));
		cleanups.push(() => rooms.close());
		const worker = (
			name: string,
			sandboxed: boolean,
		): PeerRecord["worker"] => ({
			name,
			state: "running",
			sandboxed,
			prompt: async () => {},
			park: async () => {},
			resume: async () => {},
			stop: async () => {},
		});
		const peers = new Map<string, PeerRecord>([
			[
				"plain",
				{
					worker: worker("plain", false),
					accountId: "acct-1",
					rooms: [],
				},
			],
			[
				"sandboxed",
				{
					worker: worker("sandboxed", true),
					accountId: "acct-1",
					rooms: [],
				},
			],
		]);
		const socket = await startControlSocket({
			socketPath: join(dir, "status.sock"),
			context: {
				rooms,
				supervisor: undefined as unknown as Supervisor,
				peers,
				knownRooms: new Map(),
				schedules: new Map(),
				startedAt: Date.now(),
				now: Date.now,
				ensureRoom: async () => {},
				spawnPeer: async () => ({ name: "none", state: "stopped" }),
				armSchedule: () => undefined,
				bumpAccount: async () => [],
			},
		});
		cleanups.push(() => socket.close());
		const expected = [
			{ name: "plain", sandboxed: false },
			{ name: "sandboxed", sandboxed: true },
		];
		const sandboxState = (agents: AgentStatusResult["agents"]) =>
			agents
				.map(({ name, sandboxed }) => ({ name, sandboxed }))
				.sort((left, right) => left.name.localeCompare(right.name));

		const status = await call<StatusResult>(socket.socketPath, "status");
		expect(sandboxState(status.agents)).toEqual(expected);

		const agentStatus = await call<AgentStatusResult>(
			socket.socketPath,
			"agent_status",
		);
		expect(sandboxState(agentStatus.agents)).toEqual(expected);
	});

	test("sandboxed result validation is additive and type-safe", () => {
		const agent = { name: "reviewer", state: "running", account: "acct-1" };
		expect(METHODS.agent_status.validateResult({ agents: [agent] }).ok).toBe(
			true,
		);
		expect(
			METHODS.agent_status.validateResult({
				agents: [
					{ ...agent, sandboxed: true },
					{ ...agent, sandboxed: false },
				],
			}).ok,
		).toBe(true);

		const invalid = METHODS.agent_status.validateResult({
			agents: [{ ...agent, sandboxed: "yes" }],
		});
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.field).toBe("agents[0].sandboxed");
	});

	test("the real worker factory receives a peer's spawns closure", async () => {
		// Caught by a smoke test, not by this suite as first written: every test
		// injected a stub factory, so nothing exercised what the production
		// factory is handed. `materializeWorker` refuses to build a root when a
		// `spawns:` entry has no source markdown, so the daemon died at boot for
		// any peer with a spawns closure — which is every realistic peer.
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");

		// A spawn target is an ordinary OMP task agent, so it lives in the agent
		// dir's native `agents/` directory, not in the private peer store.
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "scout.md"),
			'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
			"utf8",
		);

		const seen = new Map<string, Record<string, string>>();
		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir: agentDir,
			workerFactory: async ({ peer, sourceSpawnAgents }) => {
				seen.set(peer.name, sourceSpawnAgents);
				return {
					name: peer.name,
					state: "running",
					prompt: async () => {},
					park: async () => {},
					resume: async () => {},
					stop: async () => {},
				};
			},
		});
		cleanups.push(() => handle.close());

		const forReviewer = seen.get("reviewer") ?? {};
		expect(Object.keys(forReviewer)).toEqual(["scout"]);
		// The daemon must hand over the real file, since `materializeWorker`
		// writes it verbatim into the worker's private agent dir.
		expect(forReviewer.scout).toContain("You are a scout.");
	});

	test("a peer that cannot start does not take the daemon down with it", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		await writePeer(agentDir, "broken");

		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir: agentDir,
			workerFactory: async ({ peer }) => {
				if (peer.name === "broken") throw new Error("cannot materialize");
				return {
					name: peer.name,
					state: "running",
					prompt: async () => {},
					park: async () => {},
					resume: async () => {},
					stop: async () => {},
				};
			},
		});
		cleanups.push(() => handle.close());

		// The operator needs a live socket to find out what failed and why.
		const status = await call<StatusResult>(handle.socketPath, "status");
		expect(status.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
	});

	test("registers every peer the store lists, with its rooms", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		await writePeer(agentDir, "researcher", { rooms: ["#research"] });

		const { handle, workers } = await boot({ agentDir });

		expect([...workers.keys()].sort()).toEqual(["researcher", "reviewer"]);

		const status = await call<StatusResult>(handle.socketPath, "status");
		expect(status.agents.map((agent) => agent.name).sort()).toEqual([
			"researcher",
			"reviewer",
		]);
		expect(status.agents.every((agent) => agent.state === "running")).toBe(
			true,
		);

		const rooms = await call<RoomsListResult>(handle.socketPath, "rooms_list");
		expect(rooms.rooms.map((room) => room.id).sort()).toEqual([
			"#research",
			"#reviews",
		]);
	});

	test("a posted message routes through the supervisor and wakes the peer", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		const { handle, workers } = await boot({ agentDir });

		const posted = await call<ChatSendResult>(handle.socketPath, "chat_send", {
			room: "#reviews",
			body: "please review #42",
		});
		expect(posted.messageId).toBeGreaterThan(0);

		// Delivery is the point: a post nobody receives is a dropped message.
		expect(workers.get("reviewer")?.prompts.length).toBe(1);
		expect(workers.get("reviewer")?.prompts[0]).toContain("please review #42");

		const read = await call<ChatReadResult>(handle.socketPath, "chat_read", {
			room: "#reviews",
		});
		expect(read.messages.map((message) => message.body)).toEqual([
			"please review #42",
		]);
		// Default author is the human, per the protocol's `@you`.
		expect(read.messages[0]?.author).toBe("@you");
	});

	test("a peer's wake filter reaches the supervisor through registration", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "silent", { wake: { rooms: false } });
		const { handle, workers } = await boot({ agentDir });

		await call<ChatSendResult>(handle.socketPath, "chat_send", {
			room: "#reviews",
			body: "nothing should wake the silent peer",
		});

		// wake.rooms === false opts out of room-post wakes. If bootDaemon did
		// not pass the definition's wake config into Supervisor.register, this
		// peer would have been prompted.
		expect(workers.get("silent")?.prompts ?? []).toHaveLength(0);
	});

	test("chat_wait returns when a message lands after the call started", async () => {
		const { handle } = await boot();
		await call<ChatSendResult>(handle.socketPath, "rooms_post", {
			room: "#reviews",
			body: "first",
		});
		const first = await call<ChatReadResult>(handle.socketPath, "chat_read", {
			room: "#reviews",
		});
		const sinceId = first.messages[0]?.id ?? 0;

		const waiting = call<ChatWaitResult>(handle.socketPath, "chat_wait", {
			room: "#reviews",
			sinceId,
			timeoutMs: 5000,
		});

		// A genuine wait: the state being awaited is a request parked inside the
		// server's own event loop, which this process cannot observe. Fake timers
		// cannot drive it — the poll is real I/O over a real socket.
		await Bun.sleep(60);
		await call<ChatSendResult>(
			handle.socketPath,
			"rooms_post",
			{ room: "#reviews", body: "second" },
			2,
		);

		const result = await waiting;
		expect(result.messages.map((message) => message.body)).toEqual(["second"]);
	});

	test("chat_wait returns empty at its timeout rather than hanging", async () => {
		const { handle } = await boot();
		await call<ChatSendResult>(handle.socketPath, "rooms_post", {
			room: "#reviews",
			body: "only",
		});

		// Exercises the server's real timeout against the platform clock, which
		// is exactly the behavior under test.
		const started = Date.now();
		const result = await call<ChatWaitResult>(handle.socketPath, "chat_wait", {
			room: "#reviews",
			sinceId: 999,
			timeoutMs: 200,
		});

		expect(result.messages).toEqual([]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(150);
	});

	test("schedules from a definition are armed, listed, and disarmable", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer", {
			schedules: [
				{ cron: "0 9 * * *", prompt: "daily sweep", room: "#reviews" },
			],
		});
		const { handle } = await boot({ agentDir });

		const listed = await call<SchedulesListResult>(
			handle.socketPath,
			"schedules_list",
		);

		expect(listed.schedules.length).toBe(1);
		const schedule = listed.schedules[0];
		expect(schedule?.cron).toBe("0 9 * * *");
		expect(schedule?.enabled).toBe(true);
		expect(schedule?.nextFireAt).toBeGreaterThan(Date.now());

		const armed = await call<SchedulesArmResult>(
			handle.socketPath,
			"schedules_arm",
			{ scheduleId: schedule?.id, enabled: false },
		);
		expect(armed.schedule.enabled).toBe(false);
		expect(armed.schedule.nextFireAt).toBeNull();

		const after = await call<SchedulesListResult>(
			handle.socketPath,
			"schedules_list",
		);
		expect(after.schedules[0]?.enabled).toBe(false);
	});

	test("automations from a definition are listed as unscheduled entries", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer", {
			automations: [{ event: "pr.opened", prompt: "review it" }],
		});
		const { handle } = await boot({ agentDir });

		const listed = await call<SchedulesListResult>(
			handle.socketPath,
			"schedules_list",
		);
		expect(listed.schedules.length).toBe(1);
		// An event-driven entry has no cron and therefore no next fire time.
		expect(listed.schedules[0]?.cron).toBeNull();
		expect(listed.schedules[0]?.nextFireAt).toBeNull();
	});

	test("kill stops the worker and agent_status reflects it", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		const { handle, workers } = await boot({ agentDir });

		const killed = await call<KillResult>(handle.socketPath, "kill", {
			name: "reviewer",
		});
		expect(killed).toEqual({ name: "reviewer", state: "stopped" });
		expect(workers.get("reviewer")?.state()).toBe("stopped");

		const status = await call<AgentStatusResult>(
			handle.socketPath,
			"agent_status",
			{ name: "reviewer" },
		);
		expect(status.agents.map((agent) => agent.state)).toEqual(["stopped"]);
	});

	test("bump raises a metered account's budget through the registry", async () => {
		const agentDir = await tempAgentDir();
		// `autonomy.budgetUsd` is what makes an account metered (§9.4).
		await writePeer(agentDir, "reviewer", { autonomy: { budgetUsd: 10 } });
		const { handle, workers } = await boot({ agentDir });

		const status = await call<AgentStatusResult>(
			handle.socketPath,
			"agent_status",
			{ name: "reviewer" },
		);
		const account = status.agents[0]?.account ?? "";
		expect(account.length).toBeGreaterThan(0);

		const bumped = await call<BumpResult>(handle.socketPath, "bump", {
			account,
			budgetUsd: 50,
		});
		expect(bumped.account).toBe(account);
		expect(bumped.budgetUsd).toBe(50);
		expect(workers.get("reviewer")?.state()).toBe("running");
	});

	test("agent_spawn builds a worker through the injected factory", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "researcher", { rooms: ["#research"] });
		const { handle, workers } = await boot({ agentDir });

		const spawned = await call<AgentSpawnResult>(
			handle.socketPath,
			"agent_spawn",
			{ name: "researcher" },
		);
		expect(spawned).toEqual({ name: "researcher", state: "running" });
		expect(workers.has("researcher")).toBe(true);

		const missing = expectFailure(
			await rpc(handle.socketPath, "agent_spawn", { name: "nobody" }),
		);
		expect(missing.error.code).toBe(ERROR_CODE.INVALID_PARAMS);
		expect(missing.error.data.field).toBe("name");
	});

	test("task_handoff delivers into a room both peers share", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "researcher");
		await writePeer(agentDir, "reviewer");
		const { handle, workers } = await boot({ agentDir });

		const result = await call<TaskHandoffResult>(
			handle.socketPath,
			"task_handoff",
			{
				fromAgent: "researcher",
				toAgent: "reviewer",
				summary: "findings ready",
			},
		);

		expect(result.handoffId.length).toBeGreaterThan(0);
		expect(workers.get("reviewer")?.prompts.join("\n")).toContain(
			"findings ready",
		);
	});
});

// ── T-507 error shapes ───────────────────────────────────────────────────────

describe("bootDaemon — protocol errors", () => {
	test("an unknown method answers method-not-found carrying the version", async () => {
		const { handle } = await boot();
		const failure = expectFailure(
			await rpc(handle.socketPath, "no_such_method", {}),
		);

		expect(failure.error.code).toBe(ERROR_CODE.METHOD_NOT_FOUND);
		expect(failure.error.message).toContain("no_such_method");
		expect(failure.error.data.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(failure.id).toBe(1);
	});

	test("malformed params are refused with the offending field named", async () => {
		const { handle } = await boot();
		const failure = expectFailure(
			await rpc(handle.socketPath, "chat_send", { body: "no room" }),
		);

		expect(failure.error.code).toBe(ERROR_CODE.INVALID_PARAMS);
		expect(failure.error.data.field).toBe("room");
		expect(failure.error.data.protocolVersion).toBe(PROTOCOL_VERSION);
	});

	test("omitted params validate as an empty object for no-param methods", async () => {
		const { handle } = await boot();
		const res = await fetch("http://localhost/rpc", {
			unix: handle.socketPath,
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "status" }),
		});
		const frame = (await res.json()) as JsonRpcSuccess | JsonRpcFailure;
		expect(frame).toHaveProperty("result");
	});

	test("an unparseable frame answers a parse error", async () => {
		const { handle } = await boot();
		const res = await fetch("http://localhost/rpc", {
			unix: handle.socketPath,
			method: "POST",
			body: "{not json",
		});
		const failure = expectFailure(
			(await res.json()) as JsonRpcSuccess | JsonRpcFailure,
		);
		expect(failure.error.code).toBe(ERROR_CODE.PARSE_ERROR);
		expect(failure.error.data.protocolVersion).toBe(PROTOCOL_VERSION);
	});

	test("a non-POST request is refused", async () => {
		const { handle } = await boot();
		const res = await fetch("http://localhost/rpc", {
			unix: handle.socketPath,
			method: "GET",
		});
		expect(res.status).toBe(405);
	});

	test("every declared method is served, none answers method-not-found", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		await writePeer(agentDir, "researcher");
		const { handle } = await boot({ agentDir });

		const params: Record<MethodName, unknown> = {
			status: {},
			chat_send: { room: "#reviews", body: "hello" },
			chat_read: { room: "#reviews" },
			chat_wait: { room: "#reviews", sinceId: 999, timeoutMs: 50 },
			agent_spawn: { name: "researcher" },
			agent_status: {},
			task_handoff: {
				fromAgent: "researcher",
				toAgent: "reviewer",
				summary: "done",
			},
			rooms_list: {},
			rooms_post: { room: "#reviews", body: "hello again" },
			schedules_list: {},
			schedules_arm: { scheduleId: "missing", enabled: false },
			kill: { name: "reviewer" },
			bump: { account: "anthropic", budgetUsd: 5 },
		};

		for (const [method, payload] of Object.entries(params)) {
			const frame = await rpc(handle.socketPath, method, payload);
			if ("error" in frame) {
				// A handler may legitimately reject its arguments; it may never
				// claim the method does not exist.
				expect(frame.error.code).not.toBe(ERROR_CODE.METHOD_NOT_FOUND);
				continue;
			}
			const validated = METHODS[method as MethodName].validateResult(
				frame.result,
			);
			if (!validated.ok) {
				throw new Error(
					`${method} result violates its contract at ${validated.field}: ${validated.message}`,
				);
			}
		}
	});
});

// ── Single instance ──────────────────────────────────────────────────────────

describe("bootDaemon — single instance per profile", () => {
	test("a second daemon on the same agent dir refuses to start, and starts after close", async () => {
		const agentDir = await tempAgentDir();
		const first = await boot({ agentDir });

		await expect(
			bootDaemon({
				env: {},
				agentDir,
				projectDir: agentDir,
				workerFactory: stubWorkerFactory().factory,
			}),
		).rejects.toThrow(/already running/i);

		await first.handle.close();

		const second = await bootDaemon({
			env: {},
			agentDir,
			projectDir: agentDir,
			workerFactory: stubWorkerFactory().factory,
		});
		cleanups.push(() => second.close());

		const status = await call<StatusResult>(second.socketPath, "status");
		expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
	});

	test("a stale pidfile naming a dead process is replaced", async () => {
		const agentDir = await tempAgentDir();
		const dir = join(agentDir, "oh-my-agent");
		await mkdir(dir, { recursive: true });

		// A pid that cannot be alive: spawn a child, reap it, reuse its pid.
		const corpse = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		await corpse.exited;
		await writeFile(join(dir, "daemon.pid"), String(corpse.pid), "utf8");

		const { handle } = await boot({ agentDir });
		expect(await Bun.file(handle.pidPath).text()).toBe(String(process.pid));
	});

	test("a stale socket file left by a crash does not block listen", async () => {
		const agentDir = await tempAgentDir();
		const dir = join(agentDir, "oh-my-agent");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "daemon.sock"), "", "utf8");

		const { handle } = await boot({ agentDir });
		const status = await call<StatusResult>(handle.socketPath, "status");
		expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
	});
});

// ── Shutdown ─────────────────────────────────────────────────────────────────

describe("bootDaemon — shutdown", () => {
	test("close removes the pidfile and socket, and the socket stops answering", async () => {
		const { handle } = await boot();
		expect(existsSync(handle.pidPath)).toBe(true);
		expect(existsSync(handle.socketPath)).toBe(true);

		await handle.close();

		expect(existsSync(handle.pidPath)).toBe(false);
		expect(existsSync(handle.socketPath)).toBe(false);
		await expect(rpc(handle.socketPath, "status")).rejects.toThrow();
	});

	test("close is idempotent", async () => {
		const { handle } = await boot();
		await handle.close();
		await handle.close();
	});

	test("close stops every worker it started", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		const { handle, workers } = await boot({ agentDir });

		await handle.close();

		expect(workers.get("reviewer")?.state()).toBe("stopped");
	});

	test("a parked chat_wait stops polling once the socket closes", async () => {
		// Drive `startControlSocket` directly: the observable invariant is that
		// the parked loop notices the close and stops reading the store, and the
		// store is the only place that is visible from outside the server.
		//
		// Asserting on `close()`'s wall-clock duration instead would prove
		// nothing — `server.stop(true)` returns immediately on a unix socket
		// (verified on Bun 1.3.14), so that assertion passes even for a loop
		// that polls a closed database forever.
		const dir = await tempAgentDir();
		const rooms = await RoomStore.open(join(dir, "rooms.db"));
		cleanups.push(() => rooms.close());
		await rooms.createRoom({ id: "#reviews", kind: "channel" });

		let reads = 0;
		const countingRooms = new Proxy(rooms, {
			get(target, property, receiver) {
				if (property === "listMessages") {
					return async (
						roomId: string,
						opts: { afterId?: number; limit?: number },
					) => {
						reads++;
						return await target.listMessages(roomId, opts);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		const socket = await startControlSocket({
			socketPath: join(dir, "probe.sock"),
			context: {
				rooms: countingRooms,
				supervisor: undefined as unknown as Supervisor,
				peers: new Map(),
				knownRooms: new Map([
					["#reviews", { id: "#reviews", kind: "channel", name: "#reviews" }],
				]),
				schedules: new Map(),
				startedAt: Date.now(),
				now: Date.now,
				ensureRoom: async () => {},
				spawnPeer: async () => ({ name: "none", state: "stopped" }),
				armSchedule: () => undefined,
				bumpAccount: async () => [],
			},
		});

		const parked = rpc(socket.socketPath, "chat_wait", {
			room: "#reviews",
			sinceId: 999,
			timeoutMs: 30_000,
		}).catch(() => undefined);

		// Real wait: the poll must reach the server, and "parked inside the
		// server's loop" is not observable from this process.
		await Bun.sleep(200);
		await socket.close();
		const readsAtClose = reads;

		await Bun.sleep(400);
		// A loop that ignored the close would have polled several more times.
		expect(reads).toBeLessThanOrEqual(readsAtClose + 1);
		await parked;
	});
});

// ── Detachment ───────────────────────────────────────────────────────────────

describe("omp-agent daemon — detachment", () => {
	test("the CLI re-spawns detached: the socket answers after the launcher exits", async () => {
		const agentDir = await tempAgentDir();
		const socketPath = join(agentDir, "oh-my-agent", "daemon.sock");
		const pidPath = join(agentDir, "oh-my-agent", "daemon.pid");
		const mainPath = join(import.meta.dir, "..", "src", "daemon", "main.ts");

		const launcher = Bun.spawn({
			cmd: [process.execPath, mainPath, "daemon"],
			env: hermeticChildEnv({
				PI_CODING_AGENT_DIR: agentDir,
				OMP_AUTH_BROKER_URL: "",
				OMP_AUTH_BROKER_TOKEN: "",
			}),
			cwd: agentDir,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const exitCode = await launcher.exited;
		const stdout = await new Response(launcher.stdout).text();
		const stderr = await new Response(launcher.stderr).text();

		if (exitCode !== 0) {
			throw new Error(
				`launcher exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
			);
		}
		// The launcher's whole output contract: where to reach the daemon.
		expect(stdout).toContain(socketPath);

		cleanups.push(async () => {
			try {
				const pid = Number(await Bun.file(pidPath).text());
				if (Number.isInteger(pid)) process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		});

		// The launcher is gone; the daemon it detached must still be there.
		const status = await until(async () => {
			try {
				return await call<StatusResult>(socketPath, "status");
			} catch {
				return undefined;
			}
		}, "the detached daemon to answer its socket");
		expect(status.protocolVersion).toBe(PROTOCOL_VERSION);

		// SIGTERM must take it down cleanly. The pidfile is removed last, so it
		// is the marker that the whole reverse-order shutdown ran.
		process.kill(Number(await Bun.file(pidPath).text()), "SIGTERM");
		await until(
			() => (existsSync(pidPath) ? undefined : true),
			"the detached daemon to remove its pidfile",
		);
		expect(existsSync(socketPath)).toBe(false);
	}, 60_000);
});
