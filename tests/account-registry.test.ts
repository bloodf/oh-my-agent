/**
 * RED tests for src/daemon/account-registry.ts
 *
 * Public API under test: `AccountRegistry`.
 *
 * The registry is what makes quota handling autonomous (§9.4): billing is a
 * property of the *account*, not the agent, so it owns the per-account state
 * machines and — critically — arms the one-shot resume timer itself from a
 * block's verified `blockedUntilMs`. Nothing else in the daemon should have to
 * remember to schedule a resume.
 *
 * It also owns the wake path: a parked worker is woken when its account
 * recovers, and a wake for a still-blocked account is refused rather than
 * burning a turn that will immediately fail.
 *
 * Metered accounts warn at 80% and park at 100% with no auto-resume — a human
 * bumps the budget. Subscription accounts park on a block and auto-resume at
 * the deadline with no human in the loop.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";

import { AccountRegistry } from "../src/daemon/account-registry";
import { Scheduler } from "../src/daemon/scheduler";
import type { QuotaBlock } from "../src/daemon/quota-state";

// ── Harness ──────────────────────────────────────────────────────────────────

type Captured = { delayMs: number; callback: () => void };

function harness(startMs = 1_000_000) {
	let now = startMs;
	const captured: Captured[] = [];
	const live = new Map<number, Captured>();
	let nextId = 1;

	const scheduler = new Scheduler({
		now: () => now,
		setTimer: (callback, delayMs) => {
			const id = nextId++;
			const entry = { delayMs, callback };
			captured.push(entry);
			live.set(id, entry);
			return id;
		},
		clearTimer: (id) => {
			live.delete(id as number);
		},
	});
	scheduler.start();

	const woken: string[] = [];
	const parked: string[] = [];
	const resumed: string[] = [];
	const warned: string[] = [];

	const registry = new AccountRegistry({
		scheduler,
		now: () => now,
		onPark: (accountId, runIds) => parked.push(`${accountId}:${runIds.join(",")}`),
		onResume: (accountId, runIds) => resumed.push(`${accountId}:${runIds.join(",")}`),
		onWarning: (accountId) => warned.push(accountId),
		onWake: (runId) => woken.push(runId),
	});

	return {
		registry,
		captured,
		woken,
		parked,
		resumed,
		warned,
		advanceTo(ms: number) {
			now = ms;
		},
		get now() {
			return now;
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

// ── Block → timer arming ─────────────────────────────────────────────────────

describe("block-driven resume arming", () => {
	test("a subscription block arms a one-shot at the verified deadline", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");

		h.registry.applyBlock("acct-1", block());

		expect(h.captured).toHaveLength(1);
		expect(h.captured[0].delayMs).toBe(900_000);
		expect(h.parked).toEqual(["acct-1:run-1"]);
	});

	test("firing the armed timer resumes the parked runs", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.applyBlock("acct-1", block());

		h.advanceTo(1_900_000);
		h.captured[0].callback();

		expect(h.resumed).toEqual(["acct-1:run-1"]);
		expect(h.registry.isParked("acct-1")).toBe(false);
	});

	test("a later block for the same credential re-arms to the new deadline", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");

		h.registry.applyBlock("acct-1", block());
		h.registry.applyBlock("acct-1", block({ blockedUntilMs: 1_000_000 + 1_800_000 }));

		expect(h.captured).toHaveLength(2);
		expect(h.captured[1].delayMs).toBe(1_800_000);

		// The superseded timer must be inert: firing it must not resume early.
		h.captured[0].callback();
		expect(h.resumed).toEqual([]);
	});

	test("a later block followed by an earlier one still resumes", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");

		// Two distinct credentials, so both blocks stay active. Arming the
		// second block's own (earlier) deadline would fire while the first is
		// still active: tick retires the timer and the account never resumes.
		h.registry.applyBlock("acct-1", block({ credentialId: 7, blockedUntilMs: 1_000_000 + 1_800_000 }));
		h.registry.applyBlock("acct-1", block({ credentialId: 8, blockedUntilMs: 1_000_000 + 600_000 }));

		const armed = h.captured[h.captured.length - 1];
		expect(armed.delayMs).toBe(1_800_000);

		h.advanceTo(1_000_000 + 1_800_000);
		armed.callback();

		expect(h.resumed).toEqual(["acct-1:run-1"]);
		expect(h.registry.isParked("acct-1")).toBe(false);
	});

	test("the resume respects the state machine's generation guard", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.applyBlock("acct-1", block());

		// A second block bumps the generation; the first timer is stale.
		h.registry.applyBlock("acct-1", block({ credentialId: 8 }));
		h.advanceTo(1_900_000);
		h.captured[0].callback();

		expect(h.resumed).toEqual([]);
	});

	test("a metered account parks at 100% and arms no resume timer", () => {
		const h = harness();
		h.registry.register("acct-1", "metered");
		h.registry.addRun("acct-1", "run-1");

		h.registry.updateMeter("acct-1", 1.0);

		expect(h.parked).toEqual(["acct-1:run-1"]);
		// Metered exhaustion needs a human budget bump, not a timer.
		expect(h.captured).toHaveLength(0);
	});

	test("a metered account warns at 80% without parking", () => {
		const h = harness();
		h.registry.register("acct-1", "metered");
		h.registry.addRun("acct-1", "run-1");

		h.registry.updateMeter("acct-1", 0.85);

		expect(h.warned).toEqual(["acct-1"]);
		expect(h.parked).toEqual([]);
		expect(h.registry.isParked("acct-1")).toBe(false);
	});

	test("bumping a metered budget resumes without a timer", () => {
		const h = harness();
		h.registry.register("acct-1", "metered");
		h.registry.addRun("acct-1", "run-1");
		h.registry.updateMeter("acct-1", 1.0);

		h.registry.bumpBudget("acct-1", 0.5);

		expect(h.resumed).toEqual(["acct-1:run-1"]);
		expect(h.captured).toHaveLength(0);
	});
});

// ── Wake path ────────────────────────────────────────────────────────────────

describe("wake path", () => {
	test("waking a healthy account delivers to the worker", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");

		expect(h.registry.wake("acct-1", "run-1")).toBe(true);
		expect(h.woken).toEqual(["run-1"]);
	});

	test("waking a parked account is refused", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.applyBlock("acct-1", block());

		// Burning a turn that will immediately fail helps nobody; the pending
		// message waits for the armed resume instead.
		expect(h.registry.wake("acct-1", "run-1")).toBe(false);
		expect(h.woken).toEqual([]);
	});

	test("a wake refused while parked succeeds after auto-resume", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.applyBlock("acct-1", block());
		expect(h.registry.wake("acct-1", "run-1")).toBe(false);

		h.advanceTo(1_900_000);
		h.captured[0].callback();

		expect(h.registry.wake("acct-1", "run-1")).toBe(true);
		expect(h.woken).toEqual(["run-1"]);
	});

	test("waking an unknown account is refused, not thrown", () => {
		const h = harness();
		expect(h.registry.wake("nope", "run-1")).toBe(false);
	});
});

// ── Registry bookkeeping ─────────────────────────────────────────────────────

describe("registry bookkeeping", () => {
	test("accounts are isolated: one parking does not park another", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.register("acct-2", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.addRun("acct-2", "run-2");

		h.registry.applyBlock("acct-1", block());

		expect(h.registry.isParked("acct-1")).toBe(true);
		expect(h.registry.isParked("acct-2")).toBe(false);
		expect(h.registry.wake("acct-2", "run-2")).toBe(true);
	});

	test("registering the same account twice keeps its existing state", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.applyBlock("acct-1", block());

		h.registry.register("acct-1", "subscription");

		expect(h.registry.isParked("acct-1")).toBe(true);
	});

	test("applying a block to an unknown account throws", () => {
		const h = harness();
		expect(() => h.registry.applyBlock("nope", block())).toThrow(/nope/);
	});

	test("removing a run drops it from future park sets", () => {
		const h = harness();
		h.registry.register("acct-1", "subscription");
		h.registry.addRun("acct-1", "run-1");
		h.registry.addRun("acct-1", "run-2");
		h.registry.removeRun("acct-1", "run-1");

		h.registry.applyBlock("acct-1", block());

		expect(h.parked).toEqual(["acct-1:run-2"]);
	});
});
