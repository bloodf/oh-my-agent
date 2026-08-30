/**
 * RED tests for src/daemon/db.ts and its wiring in src/daemon/main.ts (T-508).
 *
 * What these pin down, and why each one is here rather than implied:
 *
 * - Restart survival. Peer definitions live on disk, so a reboot re-registers
 *   agents from the store no matter what the database holds. The state only the
 *   database can carry is the state nobody wrote in a file: whether an operator
 *   disarmed a schedule, and that an agent was known at all. Both are asserted
 *   through the production surfaces — `bootDaemon`, the control socket, and
 *   `DaemonDb.open` — never a hand-rolled SQL fixture (ADR-008).
 *
 * - The orphan sweep. The registry the sweep compares against has to outlive
 *   the crash, which is the whole reason this task follows T-502. `ghost` is
 *   the peer that proves it: its definition is gone by the second boot, so the
 *   only thing that can save its directory is the persisted registry. `stray`
 *   was never registered and must go. `reviewer` is still declared and stays.
 *
 * - Run records. One row per delivered turn, naming its trigger — a room post
 *   and a cron fire are different triggers and must not read alike — and its
 *   outcome. A turn still in flight when the daemon stops closes as
 *   `interrupted` rather than staying open forever, because a dangling row
 *   claims a turn is still running long after the process is gone.
 *
 * Waiting is done on the events themselves: each stub worker hands back a
 * promise that settles when the daemon prompts it, so no test sleeps. The one
 * clock that is faked is the scheduler's, shifted so a `* * * * *` schedule's
 * next minute boundary is seconds away instead of up to a minute.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DaemonDb } from "../src/daemon/db";
import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import type {
	SchedulesArmResult,
	SchedulesListResult,
} from "../src/shared/protocol";
import { controlCall, operatorToken } from "./fixtures/control-client";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Where the materializer puts a peer's synthetic root. Named because the sweep
 * is defined against this exact layout, and a test that spelled it out inline
 * would keep passing if the daemon moved it.
 */
function workerDir(agentDir: string, name: string): string {
	return join(agentDir, "oh-my-agent", "workers", name);
}

/** Read the database back through the production accessor, never raw SQL. */
async function readDb<T>(
	agentDir: string,
	read: (db: DaemonDb) => T,
): Promise<T> {
	const db = await DaemonDb.open(join(agentDir, "oh-my-agent", "daemon.db"));
	try {
		return read(db);
	} finally {
		db.close();
	}
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
): Promise<string> {
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
	const path = join(root, `${name}.md`);
	await writeFile(path, `---\n${yaml}\n---\nYou are ${name}.\n`, "utf8");
	return path;
}

interface StubWorker {
	prompts: string[];
	/** Settles when the daemon delivers a turn, so no test polls for one. */
	prompted: Promise<string>;
	/** Release a turn the factory was told to hold open. */
	release: () => void;
}

interface StubFactory {
	factory: WorkerFactory;
	workers: Map<string, StubWorker>;
}

/**
 * Records what the daemon asked each worker to do. `hold` keeps a turn in
 * flight until released, which is the shape of a daemon stopped mid-turn.
 */
function stubWorkerFactory(options: { hold?: boolean } = {}): StubFactory {
	const workers = new Map<string, StubWorker>();

	const factory: WorkerFactory = async ({ peer }) => {
		const prompts: string[] = [];
		let state: SupervisedWorker["state"] = "running";

		let announce: (message: string) => void = () => {};
		const prompted = new Promise<string>((resolve) => {
			announce = resolve;
		});
		let release: () => void = () => {};

		workers.set(peer.name, {
			prompts,
			prompted,
			release: () => release(),
		});

		return {
			name: peer.name,
			get state() {
				return state;
			},
			prompt: async (message) => {
				prompts.push(message);
				const held = options.hold
					? new Promise<void>((resolve) => {
							release = resolve;
						})
					: undefined;
				announce(message);
				if (held) await held;
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

interface Booted extends StubFactory {
	handle: DaemonHandle;
	agentDir: string;
	logs: string[];
}

/**
 * Boot a daemon against a temp agent dir. Registered for cleanup, but every
 * test that asserts on persisted state closes it explicitly first: shutdown is
 * part of what is being tested.
 */
async function boot(
	options: {
		agentDir?: string;
		projectDir?: string;
		hold?: boolean;
		now?: () => number;
	} = {},
): Promise<Booted> {
	const agentDir = options.agentDir ?? (await tempDir("oma-persist-"));
	const projectDir = options.projectDir ?? (await tempDir("oma-project-"));
	const stub = stubWorkerFactory({ ...(options.hold ? { hold: true } : {}) });
	const logs: string[] = [];

	const handle = await bootDaemon({
		env: {},
		agentDir,
		projectDir,
		workerFactory: stub.factory,
		...(options.now ? { now: options.now } : {}),
		logger: (message) => logs.push(message),
	});
	cleanups.push(() => handle.close());

	return { ...stub, handle, agentDir, logs };
}

/** One authenticated JSON-RPC round trip over the daemon's unix socket. */
async function call<T>(
	socketPath: string,
	method: string,
	params: unknown = {},
): Promise<T> {
	const token = await operatorToken(dirname(socketPath));
	const frame = (await controlCall(socketPath, method, params, token, 1)) as {
		result?: T;
		error?: unknown;
	};
	if (frame.error) {
		throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`);
	}
	return frame.result as T;
}

/**
 * A clock offset so the next cron minute boundary lands `leadMs` from now.
 * The offset is a constant added to real time, so the fake clock still ticks
 * normally: only the first fire is pulled close. Without it, a `* * * * *`
 * schedule can take a full minute to fire, which is not a wait a suite can pay.
 */
function clockNearMinuteBoundary(leadMs: number): () => number {
	const real = Date.now();
	const offset = (60_000 - leadMs - (real % 60_000) + 60_000) % 60_000;
	return () => Date.now() + offset;
}

// ── Restart survival ─────────────────────────────────────────────────────────

describe("daemon persistence — restart survival", () => {
	test("a registered peer is written to the agents table and closed out on shutdown", async () => {
		const agentDir = await tempDir("oma-persist-");
		const projectDir = await tempDir("oma-project-");
		const definitionPath = await writePeer(agentDir, "reviewer");

		const { handle } = await boot({ agentDir, projectDir });
		await handle.close();

		const agents = await readDb(agentDir, (db) => db.listAgents());
		expect(agents).toHaveLength(1);
		const [reviewer] = agents;
		expect(reviewer?.name).toBe("reviewer");
		expect(reviewer?.definitionPath).toBe(definitionPath);
		expect(reviewer?.cwd).toBe(projectDir);
		expect(reviewer?.startedAt).toBeGreaterThan(0);
		// A row still claiming "running" after a clean stop would make every
		// restart look like a crash recovery.
		expect(reviewer?.status).toBe("stopped");
	});

	test("a second boot against the same database updates the agent rather than duplicating it", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer");

		const first = await boot({ agentDir });
		await first.handle.close();

		const second = await boot({ agentDir });
		await second.handle.close();

		const agents = await readDb(agentDir, (db) => db.listAgents());
		// The table is keyed by peer name, not by boot.
		expect(agents.map((agent) => agent.name)).toEqual(["reviewer"]);
	});

	test("an operator's disarmed schedule stays disarmed across a restart", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer", {
			schedules: [{ cron: "0 9 * * *", prompt: "Daily review sweep" }],
		});

		const first = await boot({ agentDir });
		const scheduleId = "reviewer:schedule:0";

		const armed = await call<SchedulesListResult>(
			first.handle.socketPath,
			"schedules_list",
		);
		expect(armed.schedules.map((schedule) => schedule.id)).toEqual([
			scheduleId,
		]);
		expect(armed.schedules[0]?.enabled).toBe(true);

		const disarmed = await call<SchedulesArmResult>(
			first.handle.socketPath,
			"schedules_arm",
			{ scheduleId, enabled: false },
		);
		expect(disarmed.schedule.enabled).toBe(false);
		await first.handle.close();

		// The definition still declares the schedule, so a daemon with no memory
		// re-arms it on boot and quietly undoes the operator's decision. Only the
		// database carries that decision across the restart.
		const second = await boot({ agentDir });
		const restored = await call<SchedulesListResult>(
			second.handle.socketPath,
			"schedules_list",
		);
		expect(restored.schedules).toHaveLength(1);
		expect(restored.schedules[0]?.id).toBe(scheduleId);
		expect(restored.schedules[0]?.enabled).toBe(false);
		expect(restored.schedules[0]?.nextFireAt).toBeNull();
	});

	test("a schedule left armed comes back armed, with a fresh next fire time", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer", {
			schedules: [{ cron: "0 9 * * *", prompt: "Daily review sweep" }],
		});

		const first = await boot({ agentDir });
		await first.handle.close();

		const persisted = await readDb(agentDir, (db) => db.listSchedules());
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.id).toBe("reviewer:schedule:0");
		expect(persisted[0]?.cron).toBe("0 9 * * *");
		expect(persisted[0]?.action).toBe("Daily review sweep");
		expect(persisted[0]?.enabled).toBe(true);

		const second = await boot({ agentDir });
		const restored = await call<SchedulesListResult>(
			second.handle.socketPath,
			"schedules_list",
		);
		expect(restored.schedules[0]?.enabled).toBe(true);
		// Armed means a live timer, so the next fire is ahead of the new boot,
		// not the stale deadline the previous process wrote down.
		expect(restored.schedules[0]?.nextFireAt).toBeGreaterThan(Date.now());
	});
});

// ── Orphan sweep ─────────────────────────────────────────────────────────────

describe("daemon persistence — orphan sweep", () => {
	test("boot removes a worker dir with no registry entry and keeps every registered one", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer");
		const ghostDefinition = await writePeer(agentDir, "ghost");

		// First boot registers both peers, so both outlive this process.
		const first = await boot({ agentDir });
		await first.handle.close();

		// `ghost` loses its definition: the peer store will not list it on the
		// next boot, so the persisted registry is the only thing that knows the
		// directory belongs to somebody.
		await rm(ghostDefinition);

		const live = workerDir(agentDir, "reviewer");
		const ghost = workerDir(agentDir, "ghost");
		const stray = workerDir(agentDir, "stray");
		for (const dir of [live, ghost, stray]) {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "marker"), "x", "utf8");
		}

		await boot({ agentDir });

		expect(existsSync(stray)).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(existsSync(ghost)).toBe(true);
	});

	test("the sweep says what it removed", async () => {
		const agentDir = await tempDir("oma-persist-");
		const stray = workerDir(agentDir, "stray");
		await mkdir(stray, { recursive: true });

		const { logs } = await boot({ agentDir });

		// A silent deleter of directories is not something to debug at 3am.
		expect(logs.some((line) => line.includes(stray))).toBe(true);
	});

	test("a missing workers directory is not an error", async () => {
		const agentDir = await tempDir("oma-persist-");
		const { handle } = await boot({ agentDir });
		expect(existsSync(handle.socketPath)).toBe(true);
	});
});

// ── Run records ──────────────────────────────────────────────────────────────

describe("daemon persistence — run records", () => {
	test("a delivered turn leaves exactly one run row naming its trigger and outcome", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer");

		const { handle, workers } = await boot({ agentDir });
		await call(handle.socketPath, "chat_send", {
			room: "#reviews",
			body: "please look at this",
		});
		expect(workers.get("reviewer")?.prompts).toHaveLength(1);
		await handle.close();

		const runs = await readDb(agentDir, (db) => db.listRuns());
		expect(runs).toHaveLength(1);
		const [run] = runs;
		expect(run?.agent).toBe("reviewer");
		expect(run?.trigger).toBe("room");
		expect(run?.outcome).toBe("ok");
		expect(run?.startedAt).toBeGreaterThan(0);
		expect(run?.endedAt).toBeGreaterThanOrEqual(run?.startedAt ?? 0);
	});

	test("a turn a schedule fired records the schedule as its trigger", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer", {
			schedules: [{ cron: "* * * * *", prompt: "Daily review sweep" }],
		});

		const { handle, workers } = await boot({
			agentDir,
			now: clockNearMinuteBoundary(2_000),
		});

		const reviewer = workers.get("reviewer");
		if (!reviewer) throw new Error("reviewer worker was never created");
		// Await the delivered turn itself rather than a guessed duration.
		expect(await reviewer.prompted).toContain("Daily review sweep");
		await handle.close();

		const runs = await readDb(agentDir, (db) => db.listRuns());
		expect(runs).toHaveLength(1);
		// A cron fire and a human post must not read alike in the history: they
		// are the two different reasons this system does anything unattended.
		expect(runs[0]?.trigger).toBe("schedule:reviewer:schedule:0");
		expect(runs[0]?.outcome).toBe("ok");
	});

	test("a failed turn records its outcome rather than vanishing", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer");
		const projectDir = await tempDir("oma-project-");

		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir,
			workerFactory: async ({ peer }) => ({
				name: peer.name,
				state: "running",
				prompt: async () => {
					throw new Error("model refused");
				},
				park: async () => {},
				resume: async () => {},
				stop: async () => {},
			}),
		});
		cleanups.push(() => handle.close());

		await expect(
			call(handle.socketPath, "chat_send", {
				room: "#reviews",
				body: "please look at this",
			}),
		).rejects.toThrow();
		await handle.close();

		const runs = await readDb(agentDir, (db) => db.listRuns());
		expect(runs).toHaveLength(1);
		expect(runs[0]?.outcome).toBe("error");
		expect(runs[0]?.endedAt).not.toBeNull();
	});

	test("a turn still in flight at shutdown closes as interrupted, not dangling", async () => {
		const agentDir = await tempDir("oma-persist-");
		await writePeer(agentDir, "reviewer");

		const { handle, workers } = await boot({ agentDir, hold: true });
		const reviewer = workers.get("reviewer");
		if (!reviewer) throw new Error("reviewer worker was never created");

		// The turn never completes on its own, which is exactly the shape of a
		// daemon stopped mid-turn. Shutdown severs the socket under this request,
		// so its rejection is absorbed the moment it is made: attaching the
		// handler later would let the rejection go unhandled first.
		const inFlight = call(handle.socketPath, "chat_send", {
			room: "#reviews",
			body: "please look at this",
		}).catch(() => undefined);
		await reviewer.prompted;

		await handle.close();
		reviewer.release();
		await inFlight;

		const runs = await readDb(agentDir, (db) => db.listRuns());
		expect(runs).toHaveLength(1);
		// An open row claims a turn is still running long after the process is
		// gone, which is worse than no record at all.
		expect(runs[0]?.outcome).toBe("interrupted");
		expect(runs[0]?.endedAt).toBeGreaterThan(0);
	});
});

// ── The store itself ─────────────────────────────────────────────────────────

describe("DaemonDb", () => {
	test("opening an existing database is idempotent and preserves its rows", async () => {
		const dir = await tempDir("oma-db-");
		const path = join(dir, "daemon.db");

		const first = await DaemonDb.open(path);
		first.upsertAgent({
			name: "reviewer",
			definitionPath: "/peers/reviewer.md",
			status: "running",
			workerPid: 4242,
			cwd: "/work",
			startedAt: 1_000,
		});
		first.close();
		// close() twice must not throw: shutdown runs it from more than one path.
		first.close();

		const second = await DaemonDb.open(path);
		try {
			const agents = second.listAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0]?.workerPid).toBe(4242);
		} finally {
			second.close();
		}
	});

	test("a finished run keeps the first outcome recorded for it", async () => {
		const dir = await tempDir("oma-db-");
		const db = await DaemonDb.open(join(dir, "daemon.db"));
		try {
			db.upsertAgent({
				name: "reviewer",
				definitionPath: "/peers/reviewer.md",
				status: "running",
				workerPid: null,
				cwd: "/work",
				startedAt: 1_000,
			});
			const id = db.startRun({
				agent: "reviewer",
				trigger: "room",
				startedAt: 1_000,
			});

			db.finishRun({ id, outcome: "interrupted", endedAt: 2_000 });
			// A turn released after shutdown already judged it must not rewrite
			// history: the daemon that recorded the interruption is gone.
			db.finishRun({ id, outcome: "ok", endedAt: 3_000, costUsd: 0.25 });

			const runs = db.listRuns();
			expect(runs).toHaveLength(1);
			expect(runs[0]?.outcome).toBe("interrupted");
			expect(runs[0]?.endedAt).toBe(2_000);
			expect(runs[0]?.costUsd).toBeNull();
		} finally {
			db.close();
		}
	});

	test("a run records the cost and transcript its caller reports", async () => {
		const dir = await tempDir("oma-db-");
		const db = await DaemonDb.open(join(dir, "daemon.db"));
		try {
			db.upsertAgent({
				name: "reviewer",
				definitionPath: "/peers/reviewer.md",
				status: "running",
				workerPid: null,
				cwd: "/work",
				startedAt: 1_000,
			});
			const id = db.startRun({
				agent: "reviewer",
				trigger: "room",
				startedAt: 1_000,
			});
			db.finishRun({
				id,
				outcome: "ok",
				endedAt: 2_000,
				costUsd: 1.5,
				transcriptRef: "sessions/abc.jsonl",
			});

			const runs = db.listRuns();
			expect(runs[0]?.costUsd).toBe(1.5);
			expect(runs[0]?.transcriptRef).toBe("sessions/abc.jsonl");
		} finally {
			db.close();
		}
	});

	test("interrupting open runs closes them and leaves finished ones alone", async () => {
		const dir = await tempDir("oma-db-");
		const db = await DaemonDb.open(join(dir, "daemon.db"));
		try {
			db.upsertAgent({
				name: "reviewer",
				definitionPath: "/peers/reviewer.md",
				status: "running",
				workerPid: null,
				cwd: "/work",
				startedAt: 1_000,
			});
			const done = db.startRun({
				agent: "reviewer",
				trigger: "room",
				startedAt: 1_000,
			});
			db.finishRun({ id: done, outcome: "ok", endedAt: 1_500 });
			const open = db.startRun({
				agent: "reviewer",
				trigger: "room",
				startedAt: 2_000,
			});

			expect(db.interruptOpenRuns(9_000)).toBe(1);

			const byId = new Map(db.listRuns().map((run) => [run.id, run]));
			expect(byId.get(done)?.outcome).toBe("ok");
			expect(byId.get(done)?.endedAt).toBe(1_500);
			expect(byId.get(open)?.outcome).toBe("interrupted");
			expect(byId.get(open)?.endedAt).toBe(9_000);
		} finally {
			db.close();
		}
	});
});
