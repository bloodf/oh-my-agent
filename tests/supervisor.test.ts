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
 * The staleness cases (T-505) are the exception: they build a real
 * `createPeerStore` over a temp directory and edit files on disk, because a
 * faked store cannot prove the definition is re-read rather than re-hashed
 * from the copy the worker was built from.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountRegistry } from "../src/daemon/account-registry";
import type { PeerStore } from "../src/daemon/peer-store";
import { createPeerStore } from "../src/daemon/peer-store";
import type { QuotaBlock } from "../src/daemon/quota-state";
import { Scheduler } from "../src/daemon/scheduler";
import type {
	RespawnRequest,
	SupervisedWorker,
	SupervisorDeps,
} from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";
import type { PeerDefinition } from "../src/shared/agent-definition";
import {
	fingerprintPeerDefinition,
	parsePeerDefinition,
} from "../src/shared/agent-definition";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Records what the supervisor asked the worker to do. */
function stubWorker(name = "reviewer", fingerprint?: string) {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";

	const worker: SupervisedWorker = {
		name,
		fingerprint,
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

async function harness(
	overrides: Partial<Pick<SupervisorDeps, "peers" | "respawn">> = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-sup-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(() => rooms.close());

	let now = 1_000_000;
	const timers: { delayMs: number; callback: () => void }[] = [];
	const errors: { error: unknown; peerName: string }[] = [];
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
	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => now,
		onError: (error, peerName) => errors.push({ error, peerName }),
		...overrides,
	});

	return {
		rooms,
		scheduler,
		supervisor,
		stub,
		errors,
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
		expect(h.stub.prompts).toEqual(["[#reviews] @you: Please review."]);
		expect(await h.rooms.unreadCount("reviewer", "#reviews")).toBe(0);
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

// ── Metered budget notifications (T-506) ────────────────────────────────────

describe("metered budget notifications", () => {
	test("80% posts one warning with account and budget to one deterministic room", async () => {
		const h = await harness();
		const second = stubWorker("second");
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#z-budget"],
		});
		await h.supervisor.register({
			worker: second.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#a-budget"],
		});

		h.supervisor.registry.updateMeter("acct-metered", 0.8);
		h.supervisor.registry.updateMeter("acct-metered", 0.9);
		await h.supervisor.settled();

		const selected = await h.rooms.listMessages("#a-budget", {});
		expect(selected.map((message) => message.body)).toEqual([
			"Metered account acct-metered reached 80% of its $10 budget.",
		]);
		expect(await h.rooms.listMessages("#z-budget", {})).toEqual([]);
		expect(
			second.prompts.filter((prompt) => prompt.includes("reached 80%")),
		).toHaveLength(1);
		expect(
			h.stub.prompts.filter((prompt) => prompt.includes("reached 80%")),
		).toHaveLength(0);
	});

	test("100% parks runs and posts a bump-required message", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 12.5,
			rooms: ["#budget"],
		});

		h.supervisor.registry.updateMeter("acct-metered", 1);
		await h.supervisor.settled();

		expect(h.stub.state).toBe("parked");
		const messages = await h.rooms.listMessages("#budget", {});
		expect(messages.map((message) => message.body)).toEqual([
			"Metered account acct-metered exhausted its $12.5 budget; a budget bump is required.",
		]);
	});

	test("a bump posts resume state and delivers the pre-existing backlog", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#budget"],
		});
		h.supervisor.registry.updateMeter("acct-metered", 1);
		await h.supervisor.settled();
		await h.rooms.post({ room: "#budget", author: "@you", body: "Backlog." });

		h.supervisor.bumpBudget("acct-metered", 20, 0);
		await h.supervisor.settled();

		expect(h.stub.state).toBe("running");
		expect(h.stub.prompts.join("\n")).toContain("Backlog.");
		expect(h.stub.prompts.join("\n")).toContain(
			"Metered account acct-metered resumed after its budget bump.",
		);
		expect(await h.supervisor.deliver("reviewer")).toBe(false);
	});

	test("a fresh 80% crossing after a bump warns again", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#budget"],
		});

		h.supervisor.registry.updateMeter("acct-metered", 0.8);
		await h.supervisor.settled();
		h.supervisor.registry.updateMeter("acct-metered", 1);
		await h.supervisor.settled();
		h.supervisor.bumpBudget("acct-metered", 20, 0);
		await h.supervisor.settled();
		h.supervisor.registry.updateMeter("acct-metered", 0.8);
		await h.supervisor.settled();

		const messages = await h.rooms.listMessages("#budget", {});
		expect(
			messages
				.filter((message) => message.body.includes("reached 80%"))
				.map((message) => message.body),
		).toEqual([
			"Metered account acct-metered reached 80% of its $10 budget.",
			"Metered account acct-metered reached 80% of its $20 budget.",
		]);
	});

	test("failed room setup publishes no peer, run, or account config", async () => {
		const h = await harness();
		const originalSubscribe = h.rooms.subscribe.bind(h.rooms);
		h.rooms.subscribe = async (agent, room) => {
			if (room === "#broken") throw new Error("subscribe failed");
			await originalSubscribe(agent, room);
		};

		await expect(
			h.supervisor.register({
				worker: h.stub.worker,
				accountId: "acct-setup",
				mode: "metered",
				budgetUsd: 10,
				rooms: ["#durable", "#broken"],
			}),
		).rejects.toThrow("subscribe failed");

		expect(() => h.supervisor.registry.updateMeter("acct-setup", 0.8)).toThrow(
			"Unknown account: acct-setup",
		);
		await h.supervisor.post({
			room: "#durable",
			author: "@you",
			body: "Must not reach failed peer.",
		});
		expect(h.stub.prompts).toEqual([]);

		h.rooms.subscribe = originalSubscribe;
		const later = stubWorker("later");
		await h.supervisor.register({
			worker: later.worker,
			accountId: "acct-setup",
			mode: "subscription",
			rooms: ["#later"],
		});
		await h.supervisor.applyBlock("acct-setup", block());
		await h.supervisor.settled();
		expect(later.state).toBe("parked");
	});

	test("no-room warning is held, logged, then flushed when a room appears", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: [],
		});

		expect(() =>
			h.supervisor.registry.updateMeter("acct-metered", 0.8),
		).not.toThrow();
		await h.supervisor.settled();
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0].peerName).toBe("acct-metered");

		const later = stubWorker("later");
		await h.supervisor.register({
			worker: later.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#later"],
		});

		const messages = await h.rooms.listMessages("#later", {});
		expect(messages.map((message) => message.body)).toEqual([
			"Metered account acct-metered reached 80% of its $10 budget.",
		]);
	});

	test("held notification survives a failed flush and retries later", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: [],
		});
		h.supervisor.registry.updateMeter("acct-metered", 0.8);
		await h.supervisor.settled();

		const originalPost = h.rooms.post.bind(h.rooms);
		h.rooms.post = async () => {
			throw new Error("post failed");
		};
		const later = stubWorker("later");
		await expect(
			h.supervisor.register({
				worker: later.worker,
				accountId: "acct-metered",
				mode: "metered",
				budgetUsd: 10,
				rooms: ["#later"],
			}),
		).resolves.toBeUndefined();
		expect(h.errors).toHaveLength(2);
		expect(h.errors[1].peerName).toBe("acct-metered");
		expect(h.errors[1].error).toEqual(new Error("post failed"));

		h.rooms.post = originalPost;
		const retry = stubWorker("retry");
		await h.supervisor.register({
			worker: retry.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#later"],
		});

		const messages = await h.rooms.listMessages("#later", {});
		expect(messages.map((message) => message.body)).toEqual([
			"Metered account acct-metered reached 80% of its $10 budget.",
		]);
	});

	test("concurrent registrations flush one held warning exactly once", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: [],
		});
		h.supervisor.registry.updateMeter("acct-metered", 0.8);
		await h.supervisor.settled();

		const firstPost = Promise.withResolvers<void>();
		const releasePost = Promise.withResolvers<void>();
		const secondSubscribed = Promise.withResolvers<void>();
		const originalPost = h.rooms.post.bind(h.rooms);
		const originalSubscribe = h.rooms.subscribe.bind(h.rooms);
		h.rooms.post = async (input) => {
			firstPost.resolve();
			await releasePost.promise;
			return originalPost(input);
		};
		h.rooms.subscribe = async (agent, room) => {
			await originalSubscribe(agent, room);
			if (agent === "second") secondSubscribed.resolve();
		};

		const first = stubWorker("first");
		const firstRegistration = h.supervisor.register({
			worker: first.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#a-warning"],
		});
		await firstPost.promise;
		const second = stubWorker("second");
		const secondRegistration = h.supervisor.register({
			worker: second.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#z-warning"],
		});
		await secondSubscribed.promise;
		await Bun.sleep(0);
		releasePost.resolve();
		await Promise.all([firstRegistration, secondRegistration]);

		const messages = [
			...(await h.rooms.listMessages("#a-warning", {})),
			...(await h.rooms.listMessages("#z-warning", {})),
		];
		expect(
			messages.filter((message) => message.body.includes("reached 80%")),
		).toHaveLength(1);
		expect(
			[...first.prompts, ...second.prompts].filter((prompt) =>
				prompt.includes("reached 80%"),
			),
		).toHaveLength(1);
	});

	test("invalid bump meter preserves the configured budget", async () => {
		const h = await harness();
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 10,
			rooms: ["#budget"],
		});

		expect(() => h.supervisor.bumpBudget("acct-metered", 20, 2)).toThrow(
			"Meter must be between 0 and 1",
		);
		h.supervisor.registry.updateMeter("acct-metered", 0.8);
		await h.supervisor.settled();

		const messages = await h.rooms.listMessages("#budget", {});
		expect(messages.map((message) => message.body)).toEqual([
			"Metered account acct-metered reached 80% of its $10 budget.",
		]);
	});

	test.each([
		{ label: "mode", mode: "subscription" as const, budgetUsd: 10 },
		{ label: "budget", mode: "metered" as const, budgetUsd: 11 },
	])(
		"conflicting $label registration is rejected",
		async ({ mode, budgetUsd }) => {
			const h = await harness();
			await h.supervisor.register({
				worker: h.stub.worker,
				accountId: "acct-metered",
				mode: "metered",
				budgetUsd: 10,
				rooms: [],
			});

			await expect(
				h.supervisor.register({
					worker: stubWorker("conflict").worker,
					accountId: "acct-metered",
					mode,
					budgetUsd,
					rooms: [],
				}),
			).rejects.toThrow("Conflicting account configuration: acct-metered");
		},
	);
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

// ── Definition staleness (T-505) ─────────────────────────────────────────────

/**
 * A real peer store over a temp directory. Production `createPeerStore` is used
 * rather than a hand-rolled fake, so a store that stops re-reading disk breaks
 * these tests instead of passing them (ADR-008).
 */
interface DiskPeer {
	store: PeerStore;
	write: (frontmatter: Record<string, unknown>, body?: string) => Promise<void>;
	remove: () => Promise<void>;
	definition: () => Promise<PeerDefinition>;
}

async function peerStoreOnDisk(): Promise<DiskPeer> {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-stale-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));
	const roots = {
		user: join(base, "user", "agents"),
		project: join(base, "project", "agents"),
	};
	await mkdir(roots.user, { recursive: true });
	const path = join(roots.user, "reviewer.md");

	return {
		store: createPeerStore(roots),
		write: async (frontmatter, body = "You are reviewer.") => {
			const yaml = Object.entries(frontmatter)
				.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
				.join("\n");
			await writeFile(path, `---\n${yaml}\n---\n${body}`, "utf8");
		},
		remove: () => rm(path, { force: true }),
		definition: async () =>
			parsePeerDefinition(path, await readFile(path, "utf8")),
	};
}

/** The baseline frontmatter every staleness case starts from. */
function reviewerFrontmatter(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		name: "reviewer",
		description: "Reviews PRs.",
		model: "@review",
		tools: ["read", "grep"],
		spawns: ["scout"],
		rooms: ["#reviews"],
		...extra,
	};
}

describe("definition staleness", () => {
	test("an unchanged definition reuses the parked worker with no rebuild", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());
		const fingerprint = fingerprintPeerDefinition(await disk.definition());

		const respawns: RespawnRequest[] = [];
		const stale = stubWorker("reviewer", fingerprint);
		const h = await harness({
			peers: disk.store,
			respawn: async (request) => {
				respawns.push(request);
				return stubWorker("reviewer", fingerprint).worker;
			},
		});
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: stale.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await stale.worker.park();

		await h.rooms.post({ room: "#reviews", author: "@you", body: "Same." });
		expect(await h.supervisor.deliver("reviewer")).toBe(true);

		expect(respawns).toEqual([]);
		expect(stale.prompts).toHaveLength(1);
		expect(stale.prompts[0]).toContain("Same.");
		expect(stale.state).not.toBe("stopped");
		expect(h.errors).toEqual([]);
	});

	test("formatting-only edits do not rebuild, because the fingerprint is semantic", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());
		const fingerprint = fingerprintPeerDefinition(await disk.definition());

		const respawns: RespawnRequest[] = [];
		const stale = stubWorker("reviewer", fingerprint);
		const h = await harness({
			peers: disk.store,
			respawn: async (request) => {
				respawns.push(request);
				return stubWorker("reviewer", fingerprint).worker;
			},
		});
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: stale.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await stale.worker.park();

		// Same semantics, different bytes: keys reordered on disk. A textual
		// hash of the file would rebuild here and throw away a live session for
		// nothing.
		await disk.write({
			rooms: ["#reviews"],
			spawns: ["scout"],
			tools: ["read", "grep"],
			model: "@review",
			description: "Reviews PRs.",
			name: "reviewer",
		});
		expect(fingerprintPeerDefinition(await disk.definition())).toBe(
			fingerprint,
		);

		await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Reordered.",
		});
		expect(await h.supervisor.deliver("reviewer")).toBe(true);

		expect(respawns).toEqual([]);
		expect(stale.prompts).toHaveLength(1);
	});

	test("a policy change rebuilds: the old worker stops and the fresh one is prompted", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());
		const fingerprint = fingerprintPeerDefinition(await disk.definition());

		const stale = stubWorker("reviewer", fingerprint);
		const respawns: RespawnRequest[] = [];
		let fresh = stale;
		const h = await harness({
			peers: disk.store,
			respawn: async (request) => {
				respawns.push(request);
				fresh = stubWorker(
					"reviewer",
					fingerprintPeerDefinition(request.definition),
				);
				return fresh.worker;
			},
		});
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: stale.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await stale.worker.park();

		// Deliver once against the unchanged definition first. This is what makes
		// the case prove the re-read: the store has already answered for this
		// peer, so a store that caches its first listing — or a check that
		// re-hashes the definition the worker was built from — would compare the
		// stale answer here and never fire.
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Before." });
		expect(await h.supervisor.deliver("reviewer")).toBe(true);
		expect(stale.prompts).toHaveLength(1);

		// A policy-changing edit: the peer may now spawn an extra agent.
		await disk.write(reviewerFrontmatter({ spawns: ["scout", "implementor"] }));
		const rebuilt = fingerprintPeerDefinition(await disk.definition());
		expect(rebuilt).not.toBe(fingerprint);

		await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "After edit.",
		});
		expect(await h.supervisor.deliver("reviewer")).toBe(true);

		expect(respawns).toHaveLength(1);
		expect(respawns[0].peerName).toBe("reviewer");
		expect(respawns[0].previousFingerprint).toBe(fingerprint);
		expect(fingerprintPeerDefinition(respawns[0].definition)).toBe(rebuilt);

		// The superseded process is gone, and never saw the second message.
		expect(stale.state).toBe("stopped");
		expect(stale.prompts).toHaveLength(1);
		expect(fresh.prompts).toHaveLength(1);
		expect(fresh.prompts[0]).toContain("After edit.");
	});

	test("the rebuilt worker is the one every later turn reaches", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());
		const fingerprint = fingerprintPeerDefinition(await disk.definition());

		const stale = stubWorker("reviewer", fingerprint);
		let fresh = stale;
		let rebuilds = 0;
		const h = await harness({
			peers: disk.store,
			respawn: async (request) => {
				rebuilds += 1;
				fresh = stubWorker(
					"reviewer",
					fingerprintPeerDefinition(request.definition),
				);
				return fresh.worker;
			},
		});
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: stale.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await disk.write(reviewerFrontmatter({ spawns: ["scout", "implementor"] }));

		await h.rooms.post({ room: "#reviews", author: "@you", body: "First." });
		await h.supervisor.deliver("reviewer");
		// Queued behind the rebuild: it must land on the fresh worker, not be
		// dropped and not trigger a second rebuild.
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Second." });
		await h.supervisor.deliver("reviewer");

		expect(rebuilds).toBe(1);
		expect(fresh.prompts).toHaveLength(2);
		expect(fresh.prompts[1]).toContain("Second.");
		expect(stale.prompts).toEqual([]);
	});

	test("a definition missing from disk holds the turn and reports, without throwing", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());
		const fingerprint = fingerprintPeerDefinition(await disk.definition());

		let respawned = false;
		const stale = stubWorker("reviewer", fingerprint);
		const h = await harness({
			peers: disk.store,
			respawn: async () => {
				respawned = true;
				return stubWorker("reviewer", fingerprint).worker;
			},
		});
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: stale.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await disk.remove();

		await h.rooms.post({ room: "#reviews", author: "@you", body: "Orphaned." });

		// Held, not thrown: the daemon delivery path must not blow up because an
		// operator deleted a file.
		expect(await h.supervisor.deliver("reviewer")).toBe(false);
		expect(stale.prompts).toEqual([]);
		expect(respawned).toBe(false);
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0].peerName).toBe("reviewer");
		expect(String((h.errors[0].error as Error).message)).toContain("reviewer");

		// The message is still waiting once the definition is restored.
		await disk.write(reviewerFrontmatter());
		expect(await h.supervisor.deliver("reviewer")).toBe(true);
		expect(stale.prompts[0]).toContain("Orphaned.");
	});

	test("an unwired respawn reports a clear error instead of prompting a stale worker", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());
		const fingerprint = fingerprintPeerDefinition(await disk.definition());

		const stale = stubWorker("reviewer", fingerprint);
		// No `respawn` override: the default seam is what production gets before
		// the daemon wires it.
		const h = await harness({ peers: disk.store });
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: stale.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});
		await disk.write(reviewerFrontmatter({ spawns: ["scout", "implementor"] }));

		await h.rooms.post({ room: "#reviews", author: "@you", body: "Unwired." });

		expect(await h.supervisor.deliver("reviewer")).toBe(false);
		expect(stale.prompts).toEqual([]);
		expect(h.errors).toHaveLength(1);
		expect((h.errors[0].error as Error).message).toContain("respawn not wired");
	});

	test("without a peer store configured, delivery is unchanged", async () => {
		// The staleness check is opt-in: a supervisor built without a store must
		// keep delivering, or every existing caller silently stops working.
		const h = await harness();
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: h.stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		await h.rooms.post({ room: "#reviews", author: "@you", body: "No store." });

		expect(await h.supervisor.deliver("reviewer")).toBe(true);
		expect(h.stub.prompts).toHaveLength(1);
	});

	test("a worker exposing no fingerprint is reported once, and still delivers", async () => {
		const disk = await peerStoreOnDisk();
		await disk.write(reviewerFrontmatter());

		// A wrapper that dropped `fingerprint`: the check cannot run, and the
		// silent version of this is a staleness gate that never fires.
		const blind = stubWorker("reviewer", undefined);
		const h = await harness({ peers: disk.store });
		await h.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await h.supervisor.register({
			worker: blind.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: ["#reviews"],
		});

		await h.rooms.post({ room: "#reviews", author: "@you", body: "One." });
		expect(await h.supervisor.deliver("reviewer")).toBe(true);
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Two." });
		expect(await h.supervisor.deliver("reviewer")).toBe(true);

		expect(blind.prompts).toHaveLength(2);
		// Reported, but once — not on every turn for the daemon's lifetime.
		expect(h.errors).toHaveLength(1);
		expect((h.errors[0].error as Error).message).toContain("no fingerprint");
	});
});
