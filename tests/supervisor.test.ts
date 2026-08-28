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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountRegistry } from "../src/daemon/account-registry";
import type { QuotaBlock } from "../src/daemon/quota-state";
import { Scheduler } from "../src/daemon/scheduler";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
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

	return {
		worker,
		prompts,
		get state() {
			return state;
		},
	};
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

		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "My own note.",
		});

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

		await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "While parked.",
		});

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

// ── Wake filters (T-509) ─────────────────────────────────────────────────────

describe("wake filters", () => {
	test("wake.mention true wakes a named peer on @mention", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		const mentionee = stubWorker("mentionee");
		await h.supervisor.register({
			worker: mentionee.worker,
			accountId: "acct-mention",
			mode: "subscription",
			rooms: [],
			wake: { mention: true },
		});

		const woken = await h.supervisor.post({
			room: "#general",
			author: "@you",
			body: "Hey @mentionee, please look at this.",
		});

		expect(woken).toContain("mentionee");
		expect(mentionee.prompts[0]).toContain("@mentionee");
	});

	test("wake.mention false does not wake peer on mention", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		const quiet = stubWorker("quiet");
		await h.supervisor.register({
			worker: quiet.worker,
			accountId: "acct-quiet",
			mode: "subscription",
			rooms: [],
			wake: { mention: false },
		});

		const woken = await h.supervisor.post({
			room: "#general",
			author: "@you",
			body: "Hey @quiet, you there?",
		});

		expect(woken).not.toContain("quiet");
		expect(quiet.prompts).toEqual([]);
	});

	test("unknown @name in body wakes nobody and does not throw", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		await expect(
			h.supervisor.post({
				room: "#general",
				author: "@you",
				body: "Hello @ghost, are you there?",
			}),
		).resolves.toEqual([]);
	});

	test("mentions parsed exactly once per post regardless of peer count", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		let parseCount = 0;
		const original = h.rooms.parseMentions.bind(h.rooms);
		h.rooms.parseMentions = (body: string) => {
			parseCount++;
			return original(body);
		};

		const a = stubWorker("alpha");
		const b = stubWorker("beta");
		await h.supervisor.register({
			worker: a.worker,
			accountId: "acct-a",
			mode: "subscription",
			rooms: ["#general"],
			wake: { mention: true },
		});
		await h.supervisor.register({
			worker: b.worker,
			accountId: "acct-b",
			mode: "subscription",
			rooms: ["#general"],
			wake: { mention: true },
		});

		await h.supervisor.post({
			room: "#general",
			author: "@you",
			body: "Hi @alpha and @beta.",
		});

		expect(parseCount).toBe(1);
	});

	test("own post does not wake the author via mention path", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		const self = stubWorker("self");
		await h.supervisor.register({
			worker: self.worker,
			accountId: "acct-self",
			mode: "subscription",
			rooms: ["#general"],
			wake: { mention: true },
		});

		const woken = await h.supervisor.post({
			room: "#general",
			author: "self",
			body: "I @self mention myself.",
		});

		expect(woken).not.toContain("self");
		expect(self.prompts).toEqual([]);
	});

	test("wake.rooms false suppresses subscription wake", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#updates", kind: "channel" });

		const norooms = stubWorker("norooms");
		await h.supervisor.register({
			worker: norooms.worker,
			accountId: "acct-norooms",
			mode: "subscription",
			rooms: ["#updates"],
			wake: { rooms: false },
		});

		const woken = await h.supervisor.post({
			room: "#updates",
			author: "@you",
			body: "New update posted.",
		});

		expect(woken).not.toContain("norooms");
		expect(norooms.prompts).toEqual([]);
	});

	test("wake.rooms false with mention true still wakes on mention", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#updates", kind: "channel" });

		const mentiononly = stubWorker("mentiononly");
		await h.supervisor.register({
			worker: mentiononly.worker,
			accountId: "acct-mo",
			mode: "subscription",
			rooms: ["#updates"],
			wake: { mention: true, rooms: false },
		});

		const woken = await h.supervisor.post({
			room: "#updates",
			author: "@you",
			body: "Hey @mentiononly, check this.",
		});

		expect(woken).toContain("mentiononly");
		expect(mentiononly.prompts[0]).toContain("@mentiononly");
	});

	test("mention wake reaches a peer not subscribed to the posted room", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#other", kind: "channel" });

		const outsider = stubWorker("outsider");
		await h.supervisor.register({
			worker: outsider.worker,
			accountId: "acct-out",
			mode: "subscription",
			rooms: [],
			wake: { mention: true },
		});

		const woken = await h.supervisor.post({
			room: "#other",
			author: "@you",
			body: "Paging @outsider.",
		});

		expect(woken).toContain("outsider");
		expect(outsider.prompts[0]).toContain("Paging @outsider");
	});

	test("wake.mention true on unsubscribed peer: mention while parked is deferred and delivered on timer resume", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		const parkedpeer = stubWorker("parkedpeer");
		await h.supervisor.register({
			worker: parkedpeer.worker,
			accountId: "acct-pp",
			mode: "subscription",
			rooms: [],
			wake: { mention: true },
		});

		const b = block();
		await h.supervisor.applyBlock("acct-pp", b);

		// Post @mention while peer is parked — no immediate prompt
		await h.supervisor.post({
			room: "#general",
			author: "@you",
			body: "Hey @parkedpeer, review this.",
		});
		expect(parkedpeer.prompts).toEqual([]);

		// Advance past block and fire the armed resume timer
		h.advanceTo(b.blockedUntilMs);
		h.timers[0].callback();
		await h.supervisor.settled();

		expect(parkedpeer.prompts).toHaveLength(1);
		expect(parkedpeer.prompts[0]).toContain("@parkedpeer");
	});

	test("email address mail@reviewer.com is not parsed as an @name mention", async () => {
		const h = await harness();
		await h.rooms.createRoom({ id: "#general", kind: "channel" });

		const rev = stubWorker("reviewer");
		await h.supervisor.register({
			worker: rev.worker,
			accountId: "acct-rev",
			mode: "subscription",
			rooms: [],
			wake: { mention: true },
		});

		const woken = await h.supervisor.post({
			room: "#general",
			author: "@you",
			body: "mail@reviewer.com",
		});

		expect(woken).toEqual([]);
		expect(rev.prompts).toEqual([]);
	});
});
