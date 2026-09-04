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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createPeerStore,
	type PeerDefinitionFields,
} from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import type {
	ControlSocket,
	DaemonContext,
	PeerRecord,
} from "../src/daemon/socket";
import { startControlSocket } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import { cliCommand } from "../src/extension/cli";
import type { ExtensionIO } from "../src/extension/commands";
import {
	agentsCommand,
	editCommand,
	injectCommand,
	killCommand,
	logsCommand,
	roomsPostCommand,
	roomsReadCommand,
	scheduleArmCommand,
	scheduleListCommand,
	spawnCommand,
} from "../src/extension/commands";
import ohMyAgentExtension, { managerHostFrom } from "../src/extension/index";
import type { ManagerComponent } from "../src/extension/manager";
import {
	ACTIONS,
	CASCADE,
	createManagerComponent,
	MANAGER_NEEDS_TUI,
	ManagerState,
	openManager,
} from "../src/extension/manager";
import {
	createDaemonClient,
	DAEMON_UNAVAILABLE,
	refreshWidget,
	WIDGET_KEY,
} from "../src/extension/widget";
import { RoomStore } from "../src/rooms/store";
import type { ScheduleInfo } from "../src/shared/protocol";
import {
	operatorIdentities,
	TEST_OPERATOR_TOKEN,
} from "./fixtures/control-client";

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
	selectAnswers: (string | undefined)[];
	selects: { title: string; options: string[] }[];
	editorAnswers: (string | undefined)[];
	editors: { title: string; prefill: string }[];
}

function fakeIo(answer = true): CapturedIo {
	const io: CapturedIo = {
		notices: [],
		widgets: {},
		confirms: [],
		confirmAnswer: answer,
		selectAnswer: undefined,
		selectAnswers: [],
		selects: [],
		editorAnswers: [],
		editors: [],
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
			return io.selectAnswers.length > 0
				? io.selectAnswers.shift()
				: io.selectAnswer;
		},
		async editor(title, prefill = "") {
			io.editors.push({ title, prefill });
			return io.editorAnswers.shift();
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
	/** Profile root `runCli` resolves `<agentDir>/oh-my-agent/daemon.sock` from. */
	agentDir: string;
	/** Every `killPeer` call, in order, when `options.trackKills` is set. */
	kills: { name: string; keepChildren: boolean }[];
	/** Live parentage, so a reparenting cascade is observable. */
	parents: Map<string, string>;
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
		definitions?: PeerDefinitionFields[];
		/**
		 * Wire a `killPeer` that mirrors the production cascade (ADR-011):
		 * without it the socket falls back to stopping one worker, and both
		 * cascade choices would look identical.
		 */
		trackKills?: boolean;
	} = {},
): Promise<TestDaemon> {
	const dir = await mkdtemp(join(tmpdir(), "oma-ext-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(async () => rooms.close());
	const storeRoot = join(dir, "definitions");
	await mkdir(storeRoot, { recursive: true });
	const store = createPeerStore({
		user: join(dir, "empty-user-definitions"),
		project: storeRoot,
	});
	for (const definition of options.definitions ?? []) {
		await store.write(definition, { overwrite: true });
	}
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
	// Parentage as live state the cascade mutates, mirroring the daemon's own
	// `agents.parent` column rather than re-deriving it per call.
	const parents = new Map<string, string>();
	const kills: { name: string; keepChildren: boolean }[] = [];
	for (const peer of peers) {
		if (peer.parent !== undefined) parents.set(peer.name, peer.parent);
	}
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
		store,
		writeDefinition: async (fields, writeOptions) =>
			await store.write(fields, writeOptions),
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
		...(options.trackKills !== true
			? {}
			: {
					/**
					 * Mirrors the production cascade: stop the subtree by default,
					 * or stop only the named peer and reparent its children to
					 * root when the operator opted out (ADR-011).
					 */
					killPeer: async (
						name: string,
						killOptions: { keepChildren: boolean },
					) => {
						kills.push({ name, keepChildren: killOptions.keepChildren });
						const descendants: string[] = [];
						const collect = (parent: string): void => {
							for (const [child, owner] of parents) {
								if (owner !== parent) continue;
								descendants.push(child);
								collect(child);
							}
						};
						if (!killOptions.keepChildren) collect(name);
						for (const doomed of [...descendants.reverse(), name]) {
							await peerMap.get(doomed)?.worker.stop();
						}
						if (!killOptions.keepChildren) return;
						// Reparenting must be visible on the wire, not just in the
						// harness: `agent_status` reads `peerMap`, so the record's
						// own `parent` is what an operator would see.
						for (const [child, owner] of [...parents]) {
							if (owner !== name) continue;
							parents.delete(child);
							const record = peerMap.get(child);
							if (record !== undefined) delete record.parent;
						}
					},
				}),
	};

	const stateDir = join(dir, "oh-my-agent");
	await mkdir(stateDir, { recursive: true });
	const socketPath = join(stateDir, "daemon.sock");
	const socket = await startControlSocket({
		socketPath,
		context,
		identities: operatorIdentities(),
	});
	cleanups.push(() => socket.close());
	// `createDaemonClient` reads the operator bearer from a `console-token`
	// file next to the socket, the same layout `bootDaemon` mints at boot.
	await writeFile(join(stateDir, "console-token"), TEST_OPERATOR_TOKEN, "utf8");
	return {
		socket,
		client: createDaemonClient(socketPath),
		supervisor,
		workers,
		rooms,
		agentDir: dir,
		kills,
		parents,
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
		expect(text).toContain("ctrl+g manager");
		expect(text).not.toContain("token=");
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
		await cliCommand(io, "status", {
			agentDir: join(tmpdir(), "oma-ext-no-such-profile"),
			ensure: async () => {},
		});
		await refreshWidget(missing, io);

		expect(io.notices.length).toBeGreaterThanOrEqual(10);
		for (const notice of io.notices) {
			expect(notice).toContain(DAEMON_UNAVAILABLE);
		}
		// The widget reports the daemon's absence on the status line too.
		expect(io.widgets[WIDGET_KEY]?.join(" ")).toContain(DAEMON_UNAVAILABLE);
	});
});

// ── /cli ─────────────────────────────────────────────────────────────────────

describe("/cli", () => {
	test("runs status against the real socket without PATH", async () => {
		const daemon = await startDaemon([]);
		const io = fakeIo();
		await cliCommand(io, "status", {
			agentDir: daemon.agentDir,
			ensure: async () => {},
		});
		const text = io.notices.join("\n");
		expect(text).toContain("protocol:");
		expect(text).toContain("agents: 0");
	});

	test("empty args prints usage", async () => {
		const io = fakeIo();
		await cliCommand(io, "", {
			agentDir: join(tmpdir(), "oma-cli-usage"),
			ensure: async () => {},
		});
		expect(io.notices.join("\n")).toContain("Usage: omp-agent");
	});

	test("console prints the loopback URL from the state file", async () => {
		const daemon = await startDaemon([]);
		await writeFile(
			join(daemon.agentDir, "oh-my-agent", "console-url"),
			"http://127.0.0.1:50561/?token=test-operator\n",
			"utf8",
		);
		const io = fakeIo();
		await cliCommand(io, "console", {
			agentDir: daemon.agentDir,
			ensure: async () => {},
		});
		expect(io.notices.join("\n")).toContain(
			"http://127.0.0.1:50561/?token=test-operator",
		);
	});

	test("ensure runs before the verb", async () => {
		let ensured = 0;
		const daemon = await startDaemon([]);
		await cliCommand(fakeIo(), "status", {
			agentDir: daemon.agentDir,
			ensure: async () => {
				ensured += 1;
			},
		});
		expect(ensured).toBe(1);
	});
});

// ── registration factory ─────────────────────────────────────────────────────

describe("extension factory", () => {
	test("registers the operator commands without touching the runtime", () => {
		const registered: string[] = [];
		const shortcuts: string[] = [];
		const events: string[] = [];
		const fakePi = {
			registerCommand(name: string) {
				registered.push(name);
			},
			registerShortcut(shortcut: string) {
				shortcuts.push(shortcut);
			},
			on(event: string) {
				events.push(event);
			},
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
		expect(registered).toContain("manage");
		expect(registered).toContain("cli");
		expect(registered).toContain("console");
		expect(shortcuts).toHaveLength(1);
		expect(events).toContain("session_start");
		expect(events).toContain("turn_end");
	});

	test("the manager host adapter binds ctx.ui.custom, not ctx.custom", async () => {
		// The one place the manager's shape and OMP's shape must agree. OMP puts
		// `custom` on `ctx.ui`; reading `ctx.custom` yields undefined and throws
		// at call time, and an unbound method loses its receiver.
		const daemon = await startDaemon([{ name: "alpha" }]);
		let receiver: unknown;
		const ui = {
			async custom(this: unknown) {
				receiver = this;
				return undefined;
			},
		};
		const host = managerHostFrom({
			mode: "tui",
			hasUI: true,
			ui,
		} as never);

		expect(host.mode).toBe("tui");
		expect(host.hasUI).toBe(true);
		expect(typeof host.custom).toBe("function");

		// Drive the whole command body through the adapter: it must reach
		// `ui.custom` with `ui` as the receiver.
		const io = fakeIo();
		await openManager(daemon.client, io, host);
		expect(receiver).toBe(ui);
		expect(io.notices).toEqual([]);
	});
});

// ── /manage (T-902 spike) ────────────────────────────────────────────────────

describe("manager state", () => {
	test("loads the nested tree from the real daemon socket", async () => {
		const daemon = await startDaemon([
			{ name: "zeta" },
			{ name: "charlie", parent: "bravo" },
			{ name: "bravo", parent: "alpha" },
			{ name: "alpha" },
		]);

		const state = new ManagerState(daemon.client);
		await state.load();

		expect(
			state.rows.map((row) => [row.agent.name, row.depth] as const),
		).toEqual([
			["alpha", 0],
			["bravo", 1],
			["charlie", 2],
			["zeta", 0],
		]);
		expect(state.error).toBeUndefined();
	});

	test("moves the cursor and clamps at both ends", async () => {
		const daemon = await startDaemon([{ name: "alpha" }, { name: "bravo" }]);
		const state = new ManagerState(daemon.client);
		await state.load();

		expect(state.selected()?.agent.name).toBe("alpha");
		state.moveCursor(-1);
		expect(state.cursor).toBe(0);
		state.moveCursor(1);
		expect(state.selected()?.agent.name).toBe("bravo");
		state.moveCursor(5);
		expect(state.cursor).toBe(1);
	});

	test("reports an absent daemon as an error instead of throwing", async () => {
		const state = new ManagerState(
			createDaemonClient(join(tmpdir(), "definitely-absent-manager.sock")),
		);
		await state.load();

		expect(state.error).toBe(DAEMON_UNAVAILABLE);
		expect(state.rows).toHaveLength(0);
		expect(state.renderLines()).toEqual([DAEMON_UNAVAILABLE]);
	});
});

/**
 * The component fires daemon actions from a synchronous key handler, so a
 * test must wait for the work itself rather than guess a duration. This
 * polls the component's own rendered frame until the "working…" footer
 * clears — the observable condition the following assertions depend on —
 * and fails loudly instead of hanging if it never does.
 *
 * A real macrotask yield is required, not `Bun.sleep(0)`: a kill is two
 * socket round trips (the kill, then the reload), and microtask draining
 * alone never lets the loop run.
 */
async function settle(component: ManagerComponent): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (component.render(80).join("\n").includes("working…")) {
		if (Date.now() > deadline) {
			throw new Error("manager action never settled");
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 1);
		await promise;
	}
}

describe("manager component", () => {
	test("renders the tree and closes on Esc", async () => {
		const daemon = await startDaemon([
			{ name: "bravo", parent: "alpha" },
			{ name: "alpha" },
		]);
		const state = new ManagerState(daemon.client);
		await state.load();

		// A fake tui: the component is built exactly as the real factory builds
		// it, but render() output is captured instead of painted.
		let closed = false;
		let renders = 0;
		const component = createManagerComponent(state, {
			done: () => {
				closed = true;
			},
			requestRender: () => {
				renders += 1;
			},
		});

		const first = component.render(80);
		expect(first.join("\n")).toContain("alpha");
		// Indented under its parent, and the cursor marks the first row.
		expect(first.some((line) => line.includes("  bravo"))).toBe(true);
		expect(first.some((line) => line.startsWith("› alpha"))).toBe(true);

		// An unchanged frame must return the identical array reference: the
		// engine derives its stable prefix from that identity.
		expect(component.render(80)).toBe(first);

		component.handleInput("\u001b[B");
		expect(renders).toBe(1);
		const moved = component.render(80);
		expect(moved).not.toBe(first);
		expect(moved.some((line) => line.startsWith("›   bravo"))).toBe(true);

		expect(closed).toBe(false);
		component.handleInput("\u001b");
		expect(closed).toBe(true);
	});
	test("Enter opens the action menu for the selected agent", async () => {
		const daemon = await startDaemon([{ name: "alpha" }]);
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		const menu = component.render(80).join("\n");
		expect(menu).toContain("alpha");
		expect(menu).toContain(ACTIONS.edit);
		expect(menu).toContain(ACTIONS.logs);
		expect(menu).toContain(ACTIONS.inject);
		expect(menu).toContain(ACTIONS.kill);

		// Esc backs out to the tree rather than closing the overlay.
		component.handleInput("\u001b");
		expect(component.render(80).join("\n")).toContain("↑/↓ move · Enter");
	});

	test("the logs action shows the tail and stays in the pane", async () => {
		// The pane must survive the action completing: an action helper that
		// always returns to the tree would blank it the instant it opened.
		const daemon = await startDaemon([{ name: "alpha" }]);
		daemon.workers.get("alpha")?.setStderr("first line\nsecond line");
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		component.handleInput("\u001b[B"); // to "View logs"
		component.handleInput("\r");
		// The tail is fetched over the socket; let it settle.
		await settle(component);

		const pane = component.render(80).join("\n");
		expect(pane).toContain("logs: alpha");
		expect(pane).toContain("first line");
		expect(pane).toContain("second line");
		expect(pane).toContain("Esc back");
	});

	test("inject types a line and delivers it through the daemon", async () => {
		const daemon = await startDaemon([{ name: "alpha" }]);
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B"); // to "Inject an instruction"
		component.handleInput("\r");
		for (const char of "ship it") component.handleInput(char);
		// A typo is correctable before sending.
		component.handleInput("\u007f");
		expect(component.render(80).join("\n")).toContain("> ship i");

		component.handleInput("\r");
		await settle(component);

		expect(daemon.workers.get("alpha")?.prompts.at(-1)).toBe("ship i");
		expect(component.render(80).join("\n")).toContain("Delivered to alpha");
	});

	test("an empty inject line sends nothing", async () => {
		// Enter on a blank draft must return to the tree without a round trip:
		// an empty instruction would wake the agent for no reason.
		const daemon = await startDaemon([{ name: "alpha" }]);
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		component.handleInput("\r");
		component.handleInput(" ");
		component.handleInput("\r");
		await settle(component);

		expect(daemon.workers.get("alpha")?.prompts).toEqual([]);
		// And it lands back on the tree rather than sitting in the draft.
		expect(component.render(80).join("\n")).toContain("Enter actions");
	});
});

describe("manager kill cascade", () => {
	test("a subtree kill stops the children too and sends keep_children false", async () => {
		const daemon = await startDaemon(
			[{ name: "boss" }, { name: "report", parent: "boss" }],
			{ trackKills: true },
		);
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		for (let i = 0; i < 3; i += 1) component.handleInput("\u001b[B");
		component.handleInput("\r"); // Kill
		expect(component.render(80).join("\n")).toContain("kill boss?");

		component.handleInput("y");
		// The cascade choice is presented explicitly; it is never defaulted.
		const cascade = component.render(80).join("\n");
		expect(cascade).toContain(CASCADE.subtree);
		expect(cascade).toContain(CASCADE.keep);

		component.handleInput("\r"); // subtree is the highlighted first option
		await settle(component);

		// The flag the daemon actually received, not the sentence the client
		// printed: the two differ exactly when this wiring is broken.
		expect(daemon.kills).toEqual([{ name: "boss", keepChildren: false }]);
		expect(daemon.workers.get("boss")?.state).toBe("stopped");
		expect(daemon.workers.get("report")?.state).toBe("stopped");
		expect(component.render(80).join("\n")).toContain("everything under it");
	});

	test("keeping children spares them and reparents to root", async () => {
		const daemon = await startDaemon(
			[{ name: "boss" }, { name: "report", parent: "boss" }],
			{ trackKills: true },
		);
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		for (let i = 0; i < 3; i += 1) component.handleInput("\u001b[B");
		component.handleInput("\r");
		component.handleInput("y");
		component.handleInput("\u001b[B"); // move to "Keep children"
		component.handleInput("\r");
		await settle(component);

		expect(daemon.kills).toEqual([{ name: "boss", keepChildren: true }]);
		expect(daemon.workers.get("boss")?.state).toBe("stopped");
		// The child outlives its parent — the only way that is allowed —
		// and no longer points at the dead parent.
		expect(daemon.workers.get("report")?.state).toBe("running");
		// Proven over the wire, where an operator would see it: the surviving
		// child no longer claims a dead parent.
		const status = await daemon.client.call<{
			agents: { name: string; parent?: string }[];
		}>("agent_status", {});
		expect(
			status.agents.find((a) => a.name === "report")?.parent,
		).toBeUndefined();
		expect(component.render(80).join("\n")).toContain("reparented to root");
	});

	test("declining the confirmation kills nothing", async () => {
		const daemon = await startDaemon([{ name: "boss" }], {
			trackKills: true,
		});
		const state = new ManagerState(daemon.client);
		await state.load();
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		for (let i = 0; i < 3; i += 1) component.handleInput("\u001b[B");
		component.handleInput("\r");
		component.handleInput("n");
		await settle(component);

		expect(daemon.kills).toEqual([]);
		expect(daemon.workers.get("boss")?.state).toBe("running");
	});

	test("the state layer sends the cascade flag the daemon narrows", async () => {
		// keep_children rides past METHODS (which checks only declared fields)
		// and is narrowed server-side; drive both values over the real wire.
		const daemon = await startDaemon([{ name: "solo" }, { name: "other" }], {
			trackKills: true,
		});
		const state = new ManagerState(daemon.client);
		await state.load();

		expect(await state.kill("solo", true)).toContain("reparented to root");
		expect(await state.kill("other", false)).toContain("everything under it");
		expect(daemon.kills).toEqual([
			{ name: "solo", keepChildren: true },
			{ name: "other", keepChildren: false },
		]);
		// An unknown agent surfaces the daemon's own refusal, not a throw.
		expect(await state.kill("ghost", false)).toContain("Unknown agent: ghost");
		expect(daemon.kills).toHaveLength(2);
	});
});

describe("editing flows", () => {
	const definition = (overrides: Partial<PeerDefinitionFields> = {}) => ({
		name: "alpha",
		description: "Alpha peer.",
		model: ["@review", "anthropic/claude-sonnet-4-5"],
		spawns: ["scout"],
		body: "You are alpha.",
		...overrides,
	});

	test("definition get, edit, and update round-trips through the real socket", async () => {
		const daemon = await startDaemon([{ name: "alpha" }], {
			definitions: [definition()],
		});
		const io = fakeIo();
		io.selectAnswers = ["Definition"];
		io.editorAnswers = [
			'---\nname: "alpha"\ndescription: "Edited alpha."\nmodel: ["@review"]\nspawns: ["scout"]\n---\nYou are edited alpha.\n',
		];

		await editCommand(daemon.client, io, "alpha");

		const fetched = await daemon.client.call<{
			definition: { description: string; body: string };
		}>("definition_get", { name: "alpha" });
		expect(io.editors[0]?.prefill).toContain('description: "Alpha peer."');
		expect(fetched.definition.description).toBe("Edited alpha.");
		expect(fetched.definition.body.trim()).toBe("You are edited alpha.");
	});

	test("a refused definition reopens with the error and exact draft intact", async () => {
		const daemon = await startDaemon([{ name: "alpha" }], {
			definitions: [definition()],
		});
		const io = fakeIo();
		const refused =
			'---\nname: "alpha"\ndescription: "Still here."\nspawns: []\n---\nOperator text survives.\n';
		io.selectAnswers = ["Definition"];
		io.editorAnswers = [refused, undefined];

		await editCommand(daemon.client, io, "alpha");

		expect(io.editors).toHaveLength(2);
		expect(io.editors[1]?.title.toLowerCase()).toContain("spawns");
		expect(io.editors[1]?.prefill).toBe(refused);
	});

	test("a removed field is refused instead of silently surviving the patch", async () => {
		const daemon = await startDaemon([{ name: "alpha" }], {
			definitions: [definition()],
		});
		const io = fakeIo();
		const removedModel =
			'---\nname: "alpha"\ndescription: "Alpha peer."\nspawns: ["scout"]\n---\nOperator draft.\n';
		io.selectAnswers = ["Definition"];
		io.editorAnswers = [removedModel, undefined];

		await editCommand(daemon.client, io, "alpha");

		expect(io.editors[1]?.title).toContain("removing model");
		expect(io.editors[1]?.prefill).toBe(removedModel);
	});

	test("model editing selects a configured role or free input", async () => {
		const daemon = await startDaemon([{ name: "alpha" }], {
			definitions: [definition()],
		});
		const configured = fakeIo();
		configured.selectAnswers = ["Model", "anthropic/claude-sonnet-4-5"];
		await editCommand(daemon.client, configured, "alpha");
		expect(configured.selects[1]?.options).toEqual([
			"@review",
			"anthropic/claude-sonnet-4-5",
			"Enter another model…",
		]);

		const free = fakeIo();
		free.selectAnswers = ["Model", "Enter another model…"];
		free.editorAnswers = ["openai/gpt-5"];
		await editCommand(daemon.client, free, "alpha");
		const fetched = await daemon.client.call<{
			definition: { model?: string[] };
		}>("definition_get", { name: "alpha" });
		expect(fetched.definition.model).toEqual(["openai/gpt-5"]);
	});

	test("policy updates surface rebuildRequired and next-delivery behavior", async () => {
		const daemon = await startDaemon([{ name: "alpha" }], {
			definitions: [definition()],
		});
		const io = fakeIo();
		io.selectAnswers = ["Definition"];
		io.editorAnswers = [
			'---\nname: "alpha"\ndescription: "Alpha peer."\nmodel: ["@review"]\nspawns: ["scout"]\n---\nChanged policy.\n',
		];

		await editCommand(daemon.client, io, "alpha");

		expect(io.notices.join("\n")).toContain("rebuildRequired: true");
		expect(io.notices.join("\n")).toContain("next delivery");
	});

	test("an absent daemon degrades to one operator notice", async () => {
		const io = fakeIo();
		await editCommand(
			createDaemonClient(join(tmpdir(), "definitely-absent-edit.sock")),
			io,
			"alpha",
		);
		expect(io.notices).toEqual([DAEMON_UNAVAILABLE]);
		expect(io.editors).toEqual([]);
	});
});

describe("manager edit seam", () => {
	test("the edit action calls the T-903 flow and reports its message", async () => {
		const daemon = await startDaemon([{ name: "alpha" }]);
		const state = new ManagerState(daemon.client);
		await state.load();
		const seen: string[] = [];
		const component = createManagerComponent(state, {
			done: () => {},
			requestRender: () => {},
			editFlow: async (agent) => {
				seen.push(agent.name);
				return `Edited ${agent.name}.`;
			},
		});

		component.handleInput("\r");
		component.handleInput("\r"); // "Edit definition / model" is first
		await settle(component);

		expect(seen).toEqual(["alpha"]);
		expect(component.render(80).join("\n")).toContain("Edited alpha.");
	});

	test("the production manager action runs the shared definition flow", async () => {
		const daemon = await startDaemon([{ name: "alpha" }], {
			definitions: [
				{
					name: "alpha",
					description: "Alpha peer.",
					model: ["@review"],
					spawns: ["scout"],
					body: "You are alpha.",
				},
			],
		});
		const io = fakeIo();
		io.selectAnswers = ["Model", "@review"];
		await openManager(daemon.client, io, {
			mode: "tui",
			hasUI: true,
			custom: async (factory) => {
				const component = factory(
					{ requestRender: () => {} },
					{},
					{},
					() => {},
				);
				component.handleInput("\r");
				component.handleInput("\r");
				await settle(component);
				expect(component.render(80).join("\n")).toContain(
					"rebuildRequired: false",
				);
				return undefined as never;
			},
		});
		expect(io.selects[0]?.options).toEqual(["Definition", "Model"]);
	});
});

describe("/manage degradations", () => {
	test("reports that the manager needs a TUI outside interactive mode", async () => {
		const daemon = await startDaemon([{ name: "alpha" }]);
		const io = fakeIo();
		let opened = false;

		await openManager(daemon.client, io, {
			mode: "rpc",
			hasUI: false,
			custom: async () => {
				opened = true;
				return undefined as never;
			},
		});

		expect(io.notices).toEqual([MANAGER_NEEDS_TUI]);
		expect(opened).toBe(false);
	});

	test("reports an absent daemon without opening an overlay", async () => {
		const io = fakeIo();
		let opened = false;

		await openManager(
			createDaemonClient(join(tmpdir(), "definitely-absent-manage.sock")),
			io,
			{
				mode: "tui",
				hasUI: true,
				custom: async () => {
					opened = true;
					return undefined as never;
				},
			},
		);

		expect(io.notices).toEqual([DAEMON_UNAVAILABLE]);
		expect(opened).toBe(false);
	});

	test("opens a fullscreen overlay when the TUI and daemon are both present", async () => {
		const daemon = await startDaemon([{ name: "alpha" }]);
		const io = fakeIo();
		let options: { overlay?: boolean; overlayOptions?: unknown } | undefined;

		await openManager(daemon.client, io, {
			mode: "tui",
			hasUI: true,
			custom: async (factory, opts) => {
				options = opts as typeof options;
				// Drive the real factory the way OMP does, then close it.
				let resolved = false;
				const component = factory({ requestRender: () => {} }, {}, {}, () => {
					resolved = true;
				});
				expect(component.render(80).join("\n")).toContain("alpha");
				component.handleInput("\u001b");
				expect(resolved).toBe(true);
				return undefined as never;
			},
		});

		expect(options?.overlay).toBe(true);
		expect(options?.overlayOptions).toEqual({ fullscreen: true });
		expect(io.notices).toEqual([]);
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
		// createDaemonClient reads the operator bearer from a console-token file
		// next to the socket; the stub server above ignores auth entirely, so any
		// value satisfies it.
		await writeFile(join(dir, "console-token"), TEST_OPERATOR_TOKEN, "utf8");

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
