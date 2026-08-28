/**
 * Tests for the T-504 operator surface: slash commands, the status widget,
 * and the registration factory.
 *
 * Public API under test: the exported command/widget functions in
 * `src/extension/commands.ts` and `src/extension/widget.ts`, driven against
 * the real protocol server (`startControlSocket` from src/daemon/socket.ts)
 * over a real unix socket — ADR-008: production builders, never a mock of
 * the wire. The OMP side of the seam is a captured-io fake recording
 * registerCommand/setWidget/notify/confirm calls, because OMP's runtime is
 * not running under the test suite.
 *
 * The shield assertion runs twice, once against a daemon context that marks
 * one peer sandboxed and once against the production context (which predates
 * that field): the shield must appear only in the first, because a shield on
 * an unsandboxed agent is a false security claim (ADR-005).
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/daemon/scheduler";
import type {
	ControlSocket,
	DaemonContext,
	PeerRecord,
} from "../src/daemon/socket";
import { startControlSocket } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import type { ExtensionIO } from "../src/extension/commands";
import {
	agentsCommand,
	injectCommand,
	killCommand,
	logsCommand,
	roomsPostCommand,
	roomsReadCommand,
	scheduleArmCommand,
	scheduleListCommand,
	spawnCommand,
} from "../src/extension/commands";
import ohMyAgentExtension from "../src/extension/index";
import {
	createDaemonClient,
	DAEMON_UNAVAILABLE,
	refreshWidget,
	WIDGET_KEY,
} from "../src/extension/widget";
import { RoomStore } from "../src/rooms/store";
import type { ScheduleInfo } from "../src/shared/protocol";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface CapturedIo extends ExtensionIO {
	notices: string[];
	widgets: Record<string, string[]>;
	confirms: { title: string; message: string }[];
	confirmAnswer: boolean;
	selectAnswer: string | undefined;
	selects: { title: string; options: string[] }[];
}

function fakeIo(answer = true): CapturedIo {
	const io: CapturedIo = {
		notices: [],
		widgets: {},
		confirms: [],
		confirmAnswer: answer,
		selectAnswer: undefined,
		selects: [],
		notify(message) {
			io.notices.push(message);
		},
		setWidget(key, lines) {
			io.widgets[key] = lines;
		},
		async confirm(title, message) {
			io.confirms.push({ title, message });
			return io.confirmAnswer;
		},
		async select(title, options) {
			io.selects.push({ title, options });
			return io.selectAnswer;
		},
	};
	return io;
}

function stubWorker(name: string): SupervisedWorker & {
	prompts: string[];
	setState(state: SupervisedWorker["state"]): void;
	setStderr(value: string): void;
	stderr(): string;
} {
	let state: SupervisedWorker["state"] = "running";
	const prompts: string[] = [];
	let stderr = "";
	return {
		name,
		prompts,
		get state() {
			return state;
		},
		setState(next) {
			state = next;
		},
		setStderr(value) {
			stderr = value;
		},
		stderr: () => stderr,
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
}

interface TestDaemon {
	socket: ControlSocket;
	client: ReturnType<typeof createDaemonClient>;
	supervisor: Supervisor;
	workers: Map<string, ReturnType<typeof stubWorker>>;
	rooms: RoomStore;
}

/**
 * A real control socket over a real unix socket, backed by a supervisor with
 * stub workers — the same stub pattern tests/daemon-main.test.ts uses, so the
 * wire is production and only the RPC child is replaced.
 */
async function startDaemon(
	peers: {
		name: string;
		rooms?: string[];
		sandboxed?: boolean;
		parent?: string;
	}[],
	options: {
		schedules?: Map<string, ScheduleInfo>;
		orphans?: Map<string, string>;
	} = {},
): Promise<TestDaemon> {
	const dir = await mkdtemp(join(tmpdir(), "oma-ext-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(async () => rooms.close());
	const workers = new Map<string, ReturnType<typeof stubWorker>>();
	const supervisor = new Supervisor({
		rooms,
		scheduler: new Scheduler(),
		now: Date.now,
	});

	const peerMap = new Map<string, PeerRecord>();
	const knownRooms = new Map<
		string,
		{ id: string; kind: "channel"; name: string }
	>();
	for (const peer of peers) {
		const worker = stubWorker(peer.name);
		workers.set(peer.name, worker);
		await supervisor.register({
			worker,
			accountId: "anthropic",
			mode: "subscription",
			rooms: peer.rooms ?? [],
		});
		const record: PeerRecord = {
			worker,
			accountId: "anthropic",
			rooms: peer.rooms ?? [],
		};
		if (peer.parent !== undefined) record.parent = peer.parent;
		// A daemon built against an extension-aware protocol sets this; the
		// production context leaves it absent, and the client must not invent it.
		if (peer.sandboxed !== undefined) {
			(record as PeerRecord & { sandboxed: boolean }).sandboxed =
				peer.sandboxed;
		}
		peerMap.set(peer.name, record);
		for (const room of peer.rooms ?? []) {
			knownRooms.set(room, { id: room, kind: "channel", name: room });
		}
	}

	const schedules = new Map(
		[...(options.schedules ?? new Map<string, ScheduleInfo>())].map(
			([id, schedule]) => [
				id,
				{
					id,
					peer: "test",
					cron: schedule.cron,
					action: schedule.action,
					enabled: schedule.enabled,
					nextFireAt: schedule.nextFireAt,
				},
			],
		),
	);

	const context: DaemonContext = {
		rooms,
		supervisor,
		peers: peerMap,
		knownRooms,
		...(options.orphans === undefined ? {} : { orphans: options.orphans }),
		schedules,
		startedAt: Date.now(),
		now: Date.now,
		ensureRoom: async (id) => {
			if (!knownRooms.has(id)) {
				knownRooms.set(id, { id, kind: "channel", name: id });
			}
		},
		spawnPeer: async (name) => {
			const existing = peerMap.get(name);
			if (existing && existing.worker.state !== "stopped") {
				return { name, state: existing.worker.state };
			}
			const worker = stubWorker(name);
			workers.set(name, worker);
			peerMap.set(name, { worker, accountId: "anthropic", rooms: [] });
			await supervisor.register({
				worker,
				accountId: "anthropic",
				mode: "subscription",
				rooms: [],
			});
			return { name, state: worker.state };
		},
		armSchedule: (id, enabled) => {
			const record = schedules.get(id);
			if (!record) return undefined;
			record.enabled = enabled;
			return {
				id: record.id,
				cron: record.cron,
				action: record.action,
				nextFireAt: record.nextFireAt,
				enabled: record.enabled,
			};
		},
		bumpAccount: async () => [],
	};

	const socketPath = join(dir, "daemon.sock");
	const socket = await startControlSocket({ socketPath, context });
	cleanups.push(() => socket.close());
	return {
		socket,
		client: createDaemonClient(socketPath),
		supervisor,
		workers,
		rooms,
	};
}

describe("/agents hierarchy", () => {
	test("renders roots and descendants in alphabetical tree order", async () => {
		const daemon = await startDaemon([
			{ name: "zeta" },
			{ name: "charlie", parent: "bravo" },
			{ name: "bravo", parent: "alpha" },
			{ name: "alpha" },
		]);
		const io = fakeIo();

		await agentsCommand(daemon.client, io, "");

		expect(io.notices).toEqual([
			[
				"alpha — running (anthropic)",
				"  bravo — running (anthropic)",
				"    charlie — running (anthropic)",
				"zeta — running (anthropic)",
			].join("\n"),
		]);
	});

	test("renders an orphan as a root naming its absent parent", async () => {
		const daemon = await startDaemon([], {
			orphans: new Map([["stranded", "missing-parent"]]),
		});
		const io = fakeIo();

		await agentsCommand(daemon.client, io, "");

		expect(io.notices).toEqual([
			"stranded — stopped (unknown) (orphan: missing-parent)",
		]);
	});
});

// ── /agents ──────────────────────────────────────────────────────────────────

describe("/agents", () => {
	test("lists peers with state and account from the daemon", async () => {
		const daemon = await startDaemon([
			{ name: "researcher" },
			{ name: "reviewer" },
		]);
		daemon.workers.get("reviewer")?.setState("parked");

		const io = fakeIo();
		await agentsCommand(daemon.client, io, "");

		const out = io.notices.join("\n");
		expect(out).toContain("researcher");
		expect(out).toContain("running");
		expect(out).toContain("reviewer");
		expect(out).toContain("parked");
		expect(out).toContain("anthropic");
	});

	test("shows a shield only for peers whose wire status says sandboxed", async () => {
		// The wire shape predates a sandboxed field, so the command computes
		// the marker from the payload it is handed: true shields, everything
		// else does not. The production server never sets the field today, so
		// the shield cannot appear by accident — ADR-005's false-claim rule.
		const staticClient = {
			async call<T>(): Promise<T> {
				return {
					agents: [
						{
							name: "vault",
							state: "running",
							account: "anthropic",
							sandboxed: true,
						},
						{ name: "plain", state: "running", account: "anthropic" },
						{
							name: "opted-out",
							state: "running",
							account: "anthropic",
							sandboxed: false,
						},
					],
				} as T;
			},
		};
		const io = fakeIo();
		await agentsCommand(staticClient, io, "");

		const out = io.notices.join("\n");
		const lineFor = (name: string): string => {
			const line = out.split("\n").find((l) => l.includes(name));
			if (line === undefined) throw new Error(`no line for ${name}`);
			return line;
		};
		expect(lineFor("vault")).toContain("🛡");
		expect(lineFor("plain")).not.toContain("🛡");
		expect(lineFor("opted-out")).not.toContain("🛡");
	});

	test("shows no shield against a live daemon that predates the field", async () => {
		// Full round trip: the production server (startControlSocket) strips
		// unknown record fields, so even a peer the daemon believes sandboxed
		// arrives without the flag — and must render shieldless.
		const daemon = await startDaemon([{ name: "plain", sandboxed: true }]);

		const io = fakeIo();
		await agentsCommand(daemon.client, io, "");

		const out = io.notices.join("\n");
		expect(out).toContain("plain");
		expect(out).not.toContain("🛡");
	});
});

// ── /rooms ───────────────────────────────────────────────────────────────────

describe("/rooms", () => {
	test("read renders a room transcript", async () => {
		const daemon = await startDaemon([
			{ name: "reviewer", rooms: ["#reviews"] },
		]);
		await daemon.client.call("rooms_post", {
			room: "#reviews",
			body: "first",
		});
		await daemon.client.call("rooms_post", {
			room: "#reviews",
			body: "second",
			author: "reviewer",
		});

		const io = fakeIo();
		await roomsReadCommand(daemon.client, io, "#reviews");

		const out = io.notices.join("\n");
		expect(out).toContain("first");
		expect(out).toContain("second");
		expect(out).toContain("@you");
		expect(out).toContain("reviewer");
	});

	test("post lands as @you and wakes a subscribed parked peer", async () => {
		const daemon = await startDaemon([
			{ name: "reviewer", rooms: ["#reviews"] },
		]);
		const worker = daemon.workers.get("reviewer");
		worker?.setState("parked");

		const io = fakeIo();
		await roomsPostCommand(daemon.client, io, "#reviews", "ping reviewer");

		// The post is visible on read-back and attributed to the human.
		const read = await daemon.client.call<{
			messages: { author: string; body: string }[];
		}>("chat_read", { room: "#reviews" });
		expect(read.messages.map((m) => m.body)).toContain("ping reviewer");
		expect(read.messages.find((m) => m.body === "ping reviewer")?.author).toBe(
			"@you",
		);

		// The wake path is the assertion that matters: posting as @you must
		// reach a subscribed peer. The supervisor batches the backlog into one
		// prompt to the worker (tests/supervisor.test.ts owns the park/resume
		// choreography); here the delivered batch must carry the human's post.
		const delivered = worker?.prompts.join("\n") ?? "";
		expect(delivered).toContain("ping reviewer");
	});
});

// ── /spawn ───────────────────────────────────────────────────────────────────

describe("/spawn", () => {
	test("spawns a peer that then appears in /agents", async () => {
		const daemon = await startDaemon([]);

		const io = fakeIo();
		await spawnCommand(daemon.client, io, "implementor");
		expect(io.notices.join("\n")).toContain("implementor");

		const io2 = fakeIo();
		await agentsCommand(daemon.client, io2, "");
		expect(io2.notices.join("\n")).toContain("implementor");
	});

	test("reports daemon refusal instead of throwing", async () => {
		const daemon = await startDaemon([]);
		// The stub context accepts any name, so exercise the error path through
		// /kill: an unknown peer rejects and the command surfaces a clean notice.
		const io = fakeIo();
		await killCommand(daemon.client, io, "ghost");
		expect(io.notices.join("\n")).toContain("Unknown agent: ghost");
	});

	test("a chosen parent is sent with the spawn", async () => {
		const daemon = await startDaemon([{ name: "ceo" }]);

		// Record the wire calls: the client must send the picked parent with
		// agent_spawn (ADR-011's cooperative metadata), and only after asking.
		const calls: { method: string; params: unknown }[] = [];
		const spy = {
			call: <T>(method: never, params?: unknown): Promise<T> => {
				calls.push({ method, params });
				return daemon.client.call(method, params);
			},
		};

		const io = fakeIo();
		io.selectAnswer = "ceo";
		await spawnCommand(spy as never, io, "cto");

		expect(io.selects).toHaveLength(1);
		expect(io.selects[0]?.options).toContain("ceo");
		const spawn = calls.find((call) => call.method === "agent_spawn");
		expect(spawn?.params).toMatchObject({ name: "cto", parent: "ceo" });
		expect(io.notices.join("\n")).toContain("under ceo");
	});

	test("declining the parent picker spawns at the root", async () => {
		const daemon = await startDaemon([{ name: "ceo" }]);
		const calls: { method: string; params: unknown }[] = [];
		const spy = {
			call: <T>(method: never, params?: unknown): Promise<T> => {
				calls.push({ method, params });
				return daemon.client.call(method, params);
			},
		};

		const io = fakeIo();
		io.selectAnswer = undefined; // Esc
		await spawnCommand(spy as never, io, "cto");

		const spawn = calls.find((call) => call.method === "agent_spawn");
		expect(spawn?.params).toEqual({ name: "cto" });
	});
});

// ── /kill ────────────────────────────────────────────────────────────────────

describe("/kill", () => {
	test("asks for confirmation before killing", async () => {
		const daemon = await startDaemon([{ name: "reviewer" }]);

		const io = fakeIo(true);
		await killCommand(daemon.client, io, "reviewer");

		expect(io.confirms).toHaveLength(1);
		expect(io.confirms[0]?.message).toContain("reviewer");
		expect(daemon.workers.get("reviewer")?.state).toBe("stopped");
	});

	test("does not kill when the operator declines", async () => {
		const daemon = await startDaemon([{ name: "reviewer" }]);

		const io = fakeIo(false);
		await killCommand(daemon.client, io, "reviewer");

		expect(io.confirms).toHaveLength(1);
		expect(daemon.workers.get("reviewer")?.state).toBe("running");
	});
});

// ── /logs and /inject ───────────────────────────────────────────────────────

describe("operator steering", () => {
	test("/logs prints the default last 50 lines and honors an explicit count", async () => {
		const daemon = await startDaemon([{ name: "reviewer" }]);
		daemon.workers
			.get("reviewer")
			?.setStderr(
				Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join(
					"\n",
				),
			);

		const defaultIo = fakeIo();
		await logsCommand(daemon.client, defaultIo, "reviewer");
		const defaultLines = defaultIo.notices[0]?.split("\n") ?? [];
		expect(defaultLines).toHaveLength(50);
		expect(defaultLines[0]).toBe("line 11");
		expect(defaultLines.at(-1)).toBe("line 60");

		const limitedIo = fakeIo();
		await logsCommand(daemon.client, limitedIo, "reviewer 2");
		expect(limitedIo.notices).toEqual(["line 59\nline 60"]);
	});

	test("/inject confirms immediate delivery and queued delivery", async () => {
		const daemon = await startDaemon([{ name: "reviewer" }]);
		const deliveredIo = fakeIo();
		await injectCommand(
			daemon.client,
			deliveredIo,
			"reviewer prioritize this failure",
		);
		expect(daemon.workers.get("reviewer")?.prompts.at(-1)).toBe(
			"prioritize this failure",
		);
		expect(deliveredIo.notices.join("\n")).toContain("delivered");

		const queuedIo = fakeIo();
		await injectCommand(
			{
				call: async <T>() => ({ name: "reviewer", queued: true }) as T,
			},
			queuedIo,
			"reviewer handle this next",
		);
		expect(queuedIo.notices.join("\n")).toContain("queued");
	});

	test("both steering verbs surface unknown-peer errors", async () => {
		const daemon = await startDaemon([]);
		const io = fakeIo();
		await logsCommand(daemon.client, io, "ghost");
		await injectCommand(daemon.client, io, "ghost wake up");
		expect(io.notices).toHaveLength(2);
		for (const notice of io.notices)
			expect(notice).toContain("Unknown agent: ghost");
	});
});

// ── /schedule ────────────────────────────────────────────────────────────────

describe("/schedule", () => {
	const armed: ScheduleInfo = {
		id: "reviewer:schedule:0",
		cron: "0 9 * * *",
		action: "post standup prompt",
		nextFireAt: 1_800_000_000_000,
		enabled: true,
	};

	test("lists armed schedules", async () => {
		const daemon = await startDaemon([], {
			schedules: new Map([[armed.id, armed]]),
		});

		const io = fakeIo();
		await scheduleListCommand(daemon.client, io, "");

		const out = io.notices.join("\n");
		expect(out).toContain("reviewer:schedule:0");
		expect(out).toContain("0 9 * * *");
		expect(out).toContain("enabled");
	});

	test("arms and disarms a schedule", async () => {
		const daemon = await startDaemon([], {
			schedules: new Map([[armed.id, armed]]),
		});

		const io = fakeIo();
		await scheduleArmCommand(daemon.client, io, `${armed.id} off`);
		expect(io.notices.join("\n")).toContain("disabled");

		const list = await daemon.client.call<{ schedules: ScheduleInfo[] }>(
			"schedules_list",
			{},
		);
		expect(list.schedules[0]?.enabled).toBe(false);

		await scheduleArmCommand(daemon.client, io, `${armed.id} on`);
		const relisted = await daemon.client.call<{ schedules: ScheduleInfo[] }>(
			"schedules_list",
			{},
		);
		expect(relisted.schedules[0]?.enabled).toBe(true);
	});
});

// ── widget ───────────────────────────────────────────────────────────────────

describe("status widget", () => {
	test("shows running and parked counts and unread room messages", async () => {
		const daemon = await startDaemon([
			{ name: "researcher", rooms: ["#general"] },
			{ name: "reviewer" },
		]);
		daemon.workers.get("reviewer")?.setState("parked");
		await daemon.client.call("rooms_post", {
			room: "#general",
			body: "unread one",
		});
		await daemon.client.call("rooms_post", {
			room: "#general",
			body: "unread two",
		});

		const io = fakeIo();
		await refreshWidget(daemon.client, io);

		const lines = io.widgets[WIDGET_KEY];
		expect(lines).toBeDefined();
		const text = lines?.join(" ") ?? "";
		expect(text).toContain("1 running");
		expect(text).toContain("1 parked");
		expect(text).toContain("2 unread");
	});
});

// ── daemon unavailable ───────────────────────────────────────────────────────

describe("daemon unavailable", () => {
	test("every command reports the missing daemon instead of throwing", async () => {
		const missing = createDaemonClient(
			join(tmpdir(), "oma-ext-no-such-daemon.sock"),
		);

		const io = fakeIo();
		await agentsCommand(missing, io, "");
		await spawnCommand(missing, io, "x");
		await killCommand(missing, io, "x");
		await roomsReadCommand(missing, io, "#x");
		await roomsPostCommand(missing, io, "#x", "hi");
		await logsCommand(missing, io, "x");
		await injectCommand(missing, io, "x hi");
		await scheduleListCommand(missing, io, "");
		await scheduleArmCommand(missing, io, "x on");
		await refreshWidget(missing, io);

		expect(io.notices.length).toBeGreaterThanOrEqual(9);
		for (const notice of io.notices) {
			expect(notice).toContain(DAEMON_UNAVAILABLE);
		}
		// The widget reports the daemon's absence on the status line too.
		expect(io.widgets[WIDGET_KEY]?.join(" ")).toContain(DAEMON_UNAVAILABLE);
	});
});

// ── registration factory ─────────────────────────────────────────────────────

describe("extension factory", () => {
	test("registers the operator commands without touching the runtime", () => {
		const registered: string[] = [];
		const fakePi = {
			registerCommand(name: string) {
				registered.push(name);
			},
			on() {},
		};
		// Load-time work is registration only: the OMP runtime actions throw
		// before session start, so the factory must not call them here.
		ohMyAgentExtension(fakePi as never);

		expect(registered).toContain("agents");
		expect(registered).toContain("spawn");
		expect(registered).toContain("kill");
		expect(registered).toContain("rooms");
		expect(registered).toContain("schedule");
		expect(registered).toContain("logs");
		expect(registered).toContain("inject");
	});
});

describe("daemon client validation", () => {
	test("a malformed daemon result is rejected with the offending field named", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oma-ext-client-"));
		cleanups.push(async () => await rm(dir, { recursive: true, force: true }));
		const socketPath = join(dir, "daemon.sock");
		// A server that answers with a result missing the required `agents`
		// field: the client must refuse it through the METHODS registry rather
		// than casting it into the extension.
		const server = Bun.serve({
			unix: socketPath,
			fetch: () =>
				Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { protocolVersion: 1, uptimeMs: 3 },
				}),
		});
		cleanups.push(async () => {
			await server.stop(true);
		});

		const client = createDaemonClient(socketPath);
		await expect(client.call("status", {})).rejects.toThrow(/agents/);
	});

	test("invalid params are rejected before any socket call", async () => {
		const client = createDaemonClient(join(tmpdir(), "definitely-absent.sock"));
		// `limit` must be a number; the failure names the field and never
		// reaches the (absent) socket — no DaemonUnavailableError.
		await expect(
			client.call("chat_read", { room: "#a", limit: "50" }),
		).rejects.toThrow(/limit/);
	});
});
