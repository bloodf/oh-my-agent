/**
 * RED tests for src/daemon/supervisor.ts
 *
 * Public API under test: `Supervisor`.
 *
 * This is the seam that makes the system autonomous rather than a pile of
 * composable parts: it subscribes a peer to its rooms, delivers pending
 * messages as one batched turn when the peer is woken, parks the worker when
 * its account runs out of quota, and resumes it when the armed timer fires.
 *
 * Without it, every caller would have to choreograph `pendingForAgent` →
 * `wake` → `prompt` → `markRead` by hand, and nothing would guarantee a parked
 * account stops receiving turns.
 *
 * The worker is a stub here: this suite is about orchestration, not about the
 * RPC child (covered in tests/worker-lifecycle.test.ts).
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AccountRegistry } from "../src/daemon/account-registry";
import { Scheduler } from "../src/daemon/scheduler";
import type { QuotaBlock } from "../src/daemon/quota-state";
import { Supervisor } from "../src/daemon/supervisor";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Records what the supervisor asked the worker to do. */
function stubWorker(name = "reviewer") {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";

	const worker: SupervisedWorker = {
		name,
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

	return { worker, prompts, get state() {
		return state;
	} };
}

async function harness() {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-sup-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(() => rooms.close());

	let now = 1_000_000;
	const timers: { delayMs: number; callback: () => void }[] = [];
	const scheduler = new Scheduler({
		now: () => now,
		setTimer: (callback, delayMs) => {
			timers.push({ delayMs, callback });
			return timers.length;
		},
		clearTimer: () => {},
	});
	scheduler.start();

	const stub = stubWorker();
	const supervisor = new Supervisor({ rooms, scheduler, now: () => now });

	return {
		rooms,
		scheduler,
		supervisor,
		stub,
		timers,
		advanceTo: (ms: number) => {
			now = ms;
		},
	};
}

function block(overrides: Partial<QuotaBlock> = {}): QuotaBlock {
	return {
		credentialId: 7,
		providerKey: "anthropic",
		scope: "account",
		blockedUntilMs: 1_000_000 + 900_000,
		...overrides,
	};
}

// ── Room delivery ────────────────────────────────────────────────────────────

describe("room message delivery", () => {
	test("registering a peer subscribes it to its declared rooms", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });

		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		await h.rooms.post({ room: "#reviews", author: "@you", body: "Hello." });
		expect(await h.rooms.unreadCount("reviewer", "#reviews")).toBe(1);
	});

	test("delivering batches every pending message into one turn", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		await h.rooms.post({ room: "#reviews", author: "@you", body: "First." });
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Second." });

		const delivered = await h.supervisor.deliver("reviewer");

		expect(delivered).toBe(true);
		// One turn, not two: §4.3 batches pending messages into a single prompt.
		expect(h.stub.prompts).toHaveLength(1);
		expect(h.stub.prompts[0]).toContain("First.");
		expect(h.stub.prompts[0]).toContain("Second.");
	});

	test("delivery advances the read cursor so nothing re-fires", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Once." });

		expect(await h.supervisor.deliver("reviewer")).toBe(true);
		expect(await h.supervisor.deliver("reviewer")).toBe(false);
		expect(h.stub.prompts).toHaveLength(1);
	});

	test("nothing pending means no turn is burned", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		expect(await h.supervisor.deliver("reviewer")).toBe(false);
		expect(h.stub.prompts).toEqual([]);
	});

	test("a peer's own posts do not wake it", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		await h.rooms.post({ room: "#reviews", author: "reviewer", body: "My own note." });

		// Otherwise an agent that posts a summary wakes itself forever.
		expect(await h.supervisor.deliver("reviewer")).toBe(false);
		expect(h.stub.prompts).toEqual([]);
	});

	test("a post in an unsubscribed room does not wake a peer", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#other", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		// Seed a real backlog in the peer's own room. `deliver` drains
		// everything pending, so without room scoping the unrelated post below
		// would flush this too — an agent woken by traffic it never subscribed
		// to.
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Waiting." });

		const woken = await h.supervisor.post({
			room: "#other",
			author: "@you",
			body: "Not for the reviewer.",
		});

		expect(woken).toEqual([]);
		expect(h.stub.prompts).toEqual([]);
		// The seeded backlog is untouched: nothing drained it.
		expect(await h.rooms.unreadCount("reviewer", "#reviews")).toBe(1);
	});

	test("posting through the supervisor delivers to subscribers", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		const woken = await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Please review.",
		});

		expect(woken).toEqual(["reviewer"]);
		expect(h.stub.prompts[0]).toContain("Please review.");
	});
});

// ── Quota park / resume ──────────────────────────────────────────────────────

describe("quota park and auto-resume", () => {
	test("a block parks the worker itself, not just the account", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: [],
		});

		await h.supervisor.applyBlock("acct-1", block());

		expect(h.stub.state).toBe("parked");
	});

	test("a parked worker receives no turns", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await h.supervisor.applyBlock("acct-1", block());

		await h.rooms.post({ room: "#reviews", author: "@you", body: "While parked." });

		// The message waits for the armed resume rather than failing a turn.
		expect(await h.supervisor.deliver("reviewer")).toBe(false);
		expect(h.stub.prompts).toEqual([]);
	});

	test("the armed timer resumes the worker with no human in the loop", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: [],
		});
		const b = block();
		await h.supervisor.applyBlock("acct-1", b);

		expect(h.timers).toHaveLength(1);
		h.advanceTo(b.blockedUntilMs);
		await h.timers[0].callback();
		// The resume runs on the registry's callback, which is async.
		await Bun.sleep(0);

		expect(h.stub.state).toBe("running");
	});

	test("the resume timer delivers the backlog with no human in the loop", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		const b = block();
		await h.supervisor.applyBlock("acct-1", b);
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Backlog." });

		h.advanceTo(b.blockedUntilMs);
		h.timers[0].callback();
		await h.supervisor.settled();

		// The timer alone did it: no explicit deliver() call in this test.
		expect(h.stub.prompts).toHaveLength(1);
		expect(h.stub.prompts[0]).toContain("Backlog.");
		// And nothing is left pending afterwards.
		expect(await h.supervisor.deliver("reviewer")).toBe(false);
	});
});

// ── Registry wiring ──────────────────────────────────────────────────────────

describe("registry wiring", () => {
	test("the supervisor exposes the account registry it drives", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: [],
		});

		expect(h.supervisor.registry).toBeInstanceOf(AccountRegistry);
		expect(h.supervisor.registry.isParked("acct-1")).toBe(false);
	});

	test("an unknown peer cannot be delivered to", async () => {
		const h = await harness();
		await expect(h.supervisor.deliver("nobody")).rejects.toThrow(/nobody/);
	});
});
