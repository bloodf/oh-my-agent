import { describe, expect, test } from "bun:test";
import { nextCronTime, Scheduler } from "../src/daemon/scheduler";
import { AccountStateMachine, QuotaBlock } from "../src/daemon/quota-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CapturedTimer = { delayMs: number; callback: () => void };

function makeFakeClock(startMs: number) {
  let now = startMs;
  return {
    get now() { return now; },
    set now(v: number) { now = v; },
    advance(ms: number) { now += ms; },
  };
}

function makeScheduler(clock: ReturnType<typeof makeFakeClock>) {
  const captured: CapturedTimer[] = [];
  const timers = new Map<number, CapturedTimer>();
  let nextId = 1;

  const scheduler = new Scheduler({
    now: () => clock.now,
    setTimer(callback: () => void, delayMs: number) {
      const id = nextId++;
      captured.push({ delayMs, callback });
      timers.set(id, { delayMs, callback });
      return id;
    },
    clearTimer(id: unknown) {
      timers.delete(id as number);
    },
  });

  return { scheduler, captured, timers, clock };
}

// ---------------------------------------------------------------------------
// nextCronTime
// ---------------------------------------------------------------------------

describe("nextCronTime", () => {
  test("rejects expression with too few fields", () => {
    expect(() => nextCronTime("* * *", Date.now())).toThrow();
  });

  test("rejects expression with too many fields", () => {
    expect(() => nextCronTime("* * * * * *", Date.now())).toThrow();
  });

  test("rejects non-numeric minute field", () => {
    expect(() => nextCronTime("xx * * * *", Date.now())).toThrow();
  });

  test("rejects minute out of range (60)", () => {
    expect(() => nextCronTime("60 * * * *", Date.now())).toThrow();
  });

  test("rejects minute out of range (-1)", () => {
    expect(() => nextCronTime("-1 * * * *", Date.now())).toThrow();
  });

  test("rejects hour out of range (24)", () => {
    expect(() => nextCronTime("* 24 * * *", Date.now())).toThrow();
  });

  test("rejects invalid day of month (32)", () => {
    expect(() => nextCronTime("* * 32 * *", Date.now())).toThrow();
  });

  test("rejects invalid month (13)", () => {
    expect(() => nextCronTime("* * * 13 *", Date.now())).toThrow();
  });

  test("rejects invalid weekday (7)", () => {
    expect(() => nextCronTime("* * * * 7", Date.now())).toThrow();
  });

  test("rejects reversed range (minute 30-10)", () => {
    expect(() => nextCronTime("30-10 * * * *", Date.now())).toThrow();
  });

  test("rejects step of zero", () => {
    expect(() => nextCronTime("*/0 * * * *", Date.now())).toThrow();
  });

  test("accepts wildcard minute", () => {
    expect(() => nextCronTime("* * * * *", Date.now())).not.toThrow();
  });

  test("accepts exact minute", () => {
    const now = new Date("2025-01-01T00:00:00Z").getTime();
    expect(() => nextCronTime("5 * * * *", now)).not.toThrow();
  });

  test("accepts comma-list in minute field", () => {
    const now = new Date("2025-01-01T00:00:00Z").getTime();
    expect(() => nextCronTime("5,10,15 * * * *", now)).not.toThrow();
  });

  test("accepts range in hour field", () => {
    const now = new Date("2025-01-01T00:00:00Z").getTime();
    expect(() => nextCronTime("* 9-17 * * *", now)).not.toThrow();
  });

  test("accepts step syntax", () => {
    const now = new Date("2025-01-01T00:00:00Z").getTime();
    expect(() => nextCronTime("*/5 * * * *", now)).not.toThrow();
  });

  test("returns a timestamp after the after parameter", () => {
    const now = new Date("2025-06-01T10:00:00Z").getTime();
    const result = nextCronTime("* * * * *", now);
    expect(result).toBeGreaterThan(now);
  });

  test("respects exact minute spec", () => {
    // At 10:00, next exact 30-min mark is 10:30
    const now = new Date("2025-06-01T10:00:00Z").getTime();
    const next = nextCronTime("30 * * * *", now);
    const d = new Date(next);
    expect(d.getUTCMinutes()).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe("Scheduler", () => {
  test("start schedules strictly next fire — does not fire immediately", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);

    scheduler.add("t", { cron: "* * * * *", handler: () => {} });
    scheduler.start();

    // nothing fired yet — only scheduled
    expect(captured.length).toBe(1);
    const { delayMs } = captured[0];
    expect(delayMs).toBeGreaterThan(0);
  });

  test("advancing fake now to due time then invoking callback fires handler once and reschedules", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);
    let handlerCalls = 0;

    scheduler.add("t", { cron: "* * * * *", handler: () => { handlerCalls++; } });
    scheduler.start();

    expect(captured.length).toBe(1);
    const { callback, delayMs } = captured[0];

    // advance clock to exactly the due time
    clock.now += delayMs;
    callback();

    expect(handlerCalls).toBe(1);

    // reschedule happened
    expect(captured.length).toBe(2);
  });

  test("stale callback after remove does nothing", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);
    let handlerCalls = 0;

    scheduler.add("t", { cron: "* * * * *", handler: () => { handlerCalls++; } });
    scheduler.start();

    expect(captured.length).toBe(1);
    const { callback, delayMs } = captured[0];

    scheduler.remove("t");

    clock.now += delayMs;
    callback(); // stale — removed

    expect(handlerCalls).toBe(0);
  });

  test("stale callback after stop does nothing", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);
    let handlerCalls = 0;

    scheduler.add("t", { cron: "* * * * *", handler: () => { handlerCalls++; } });
    scheduler.start();

    expect(captured.length).toBe(1);
    const { callback, delayMs } = captured[0];

    scheduler.stop();

    clock.now += delayMs;
    callback(); // stale — stopped

    expect(handlerCalls).toBe(0);
  });

  test("stale callback from prior generation is ignored after restart", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);
    let handlerCalls = 0;

    scheduler.add("t", { cron: "* * * * *", handler: () => { handlerCalls++; } });
    scheduler.start();

    const staleCallback = captured[0].callback;
    const firstDelay = captured[0].delayMs;

    scheduler.stop();
    scheduler.start(); // new generation

    clock.now += firstDelay;
    staleCallback(); // from old generation — ignored

    expect(handlerCalls).toBe(0);
  });

  test("injectable now/setTimer/clearTimer are called", () => {
    const clock = makeFakeClock(new Date("2025-08-01T12:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);

    scheduler.add("w", { cron: "0 * * * *", handler: () => {} });
    scheduler.start();

    expect(captured.length).toBe(1);
    expect(captured[0].delayMs).toBeGreaterThan(0);
  });
  test("two jobs scheduled — removing A must not invalidate B callback", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const { scheduler, captured } = makeScheduler(clock);
    let aCalls = 0;
    let bCalls = 0;

    scheduler.add("A", { cron: "* * * * *", handler: () => { aCalls++; } });
    scheduler.add("B", { cron: "* * * * *", handler: () => { bCalls++; } });
    scheduler.start();

    expect(captured.length).toBe(2);

    scheduler.remove("A");

    const bEntry = captured.find(e => e !== captured[0]);
    clock.now += captured[0].delayMs;
    if (bEntry) bEntry.callback();

    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
  });

  test("sync throw in handler reports error via onError and reschedules", () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const errors: [unknown, string][] = [];
    const captured: CapturedTimer[] = [];

    const sched = new Scheduler({
      now: () => clock.now,
      setTimer(callback, delayMs) {
        captured.push({ delayMs, callback });
        return captured.length;
      },
      clearTimer() {},
      onError(error, jobId) {
        errors.push([error, jobId]);
      },
    });

    let handlerCalls = 0;
    sched.add("E", {
      cron: "* * * * *",
      handler() {
        handlerCalls++;
        throw new Error("boom");
      },
    });
    sched.start();

    expect(captured.length).toBe(1);
    const { callback, delayMs } = captured[0];
    clock.now += delayMs;

    callback();

    expect(handlerCalls).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0][1]).toBe("E");
    expect((errors[0][0] as Error).message).toBe("boom");
    expect(captured.length).toBe(2);
  });

  test("async rejection reports error via onError after microtask and reschedules", async () => {
    const clock = makeFakeClock(new Date("2025-07-01T00:00:00Z").getTime());
    const errors: [unknown, string][] = [];
    const captured: CapturedTimer[] = [];

    const sched = new Scheduler({
      now: () => clock.now,
      setTimer(callback, delayMs) {
        captured.push({ delayMs, callback });
        return captured.length;
      },
      clearTimer() {},
      onError(error, jobId) {
        errors.push([error, jobId]);
      },
    });

    let handlerCalls = 0;
    sched.add("EA", {
      cron: "* * * * *",
      async handler() {
        handlerCalls++;
        await Promise.reject(new Error("async boom"));
      },
    });
    sched.start();

    const { callback, delayMs } = captured[0];
    clock.now += delayMs;

    callback();

    expect(handlerCalls).toBe(1);
    expect(errors.length).toBe(0);

    await Bun.sleep(0);

    expect(errors.length).toBe(1);
    expect(errors[0][1]).toBe("EA");
    expect((errors[0][0] as Error).message).toBe("async boom");
    expect(captured.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// QuotaBlock (exported from broker snapshots)
// ---------------------------------------------------------------------------

describe("QuotaBlock", () => {
  test("QuotaBlock is exported with required fields", () => {
    const block: QuotaBlock = {
      credentialId: 1,
      providerKey: "openai",
      scope: "chat",
      blockedUntilMs: Date.now() + 300_000,
    };
    expect(block.credentialId).toBe(1);
    expect(block.providerKey).toBe("openai");
    expect(block.scope).toBe("chat");
    expect(block.blockedUntilMs).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// AccountStateMachine
// ---------------------------------------------------------------------------

describe("AccountStateMachine", () => {
  type SMCounts = { warn: number; park: number; resume: number };
  type SMDep = {
    accountId: string;
    mode: "metered" | "subscription";
    now: () => number;
    onWarning: () => void;
    onPark: (runIds: string[]) => void;
    onResume: (runIds: string[]) => void;
  };

  function makeSM(deps: SMDep) {
    const counts: SMCounts = { warn: 0, park: 0, resume: 0 };
    const sm = new AccountStateMachine({
      accountId: deps.accountId,
      mode: deps.mode,
      now: deps.now,
      onWarning: deps.onWarning,
      onPark: deps.onPark,
      onResume: deps.onResume,
    });
    return { sm, counts };
  }

  // .8 warns once
  test("at 80 percent meter emits warning exactly once", () => {
    const clock = makeFakeClock(0);
    const { sm, counts } = makeSM({
      accountId: "acc-1",
      mode: "metered",
      now: () => clock.now,
      onWarning: () => { counts.warn++; },
      onPark: () => {},
      onResume: () => {},
    });

    sm.addRun("r1");
    sm.updateMeter(0.8);
    sm.tick();
    expect(counts.warn).toBe(1);
    sm.tick(); // second tick — no additional warning
    expect(counts.warn).toBe(1);
    expect(counts.park).toBe(0);
  });

  // 1.0 parks all runs
  test("at 100 percent meter parks all active runs", () => {
    const clock = makeFakeClock(0);
    let parkedRuns: string[] = [];
    const { sm, counts } = makeSM({
      accountId: "acc-1",
      mode: "metered",
      now: () => clock.now,
      onWarning: () => {},
      onPark: (runIds) => { parkedRuns = runIds; counts.park++; },
      onResume: () => {},
    });

    sm.addRun("r1");
    sm.addRun("r2");
    sm.updateMeter(1.0);
    sm.tick();

    expect(counts.park).toBe(1);
    expect(parkedRuns).toContain("r1");
    expect(parkedRuns).toContain("r2");
    expect(counts.warn).toBe(0); // skipped — went straight to park
  });

  // subscription block immediately parks all runs
  test("subscription block immediately parks all runs without waiting for meter", () => {
    const clock = makeFakeClock(0);
    let parkedRuns: string[] = [];
    const { sm, counts } = makeSM({
      accountId: "acc-1",
      mode: "subscription",
      now: () => clock.now,
      onWarning: () => {},
      onPark: (runIds) => { parkedRuns = runIds; counts.park++; },
      onResume: () => {},
    });

    sm.addRun("r1");
    sm.addRun("r2");

    const block: QuotaBlock = {
      credentialId: 1,
      providerKey: "openai",
      scope: "chat",
      blockedUntilMs: clock.now + 300_000,
    };
    sm.applyBlock(block);
    sm.tick();

    expect(counts.park).toBe(1);
    expect(parkedRuns).toContain("r1");
    expect(parkedRuns).toContain("r2");
  });

  // subscription block tick at expiry resumes all
  test("subscription block tick at expiry resumes all runs", () => {
    const clock = makeFakeClock(0);
    let resumedRuns: string[] = [];
    const block: QuotaBlock = {
      credentialId: 1,
      providerKey: "openai",
      scope: "chat",
      blockedUntilMs: clock.now + 300_000,
    };

    const { sm, counts } = makeSM({
      accountId: "acc-1",
      mode: "subscription",
      now: () => clock.now,
      onWarning: () => {},
      onPark: () => {},
      onResume: (runIds) => { resumedRuns = runIds; counts.resume++; },
    });

    sm.addRun("r1");
    sm.addRun("r2");
    sm.applyBlock(block);
    sm.tick();
    expect(counts.resume).toBe(0); // not yet expired

    // advance past blockedUntilMs
    clock.now = block.blockedUntilMs + 1;
    sm.tick();
    expect(counts.resume).toBe(1);
    expect(resumedRuns).toContain("r1");
    expect(resumedRuns).toContain("r2");
  });

  // multiple blocks resume only after latest active deadline
  test("multiple blocks resume only after latest active deadline", () => {
    const clock = makeFakeClock(0);
    const block1: QuotaBlock = {
      credentialId: 1,
      providerKey: "openai",
      scope: "chat",
      blockedUntilMs: clock.now + 600_000, // 10 min
    };
    const block2: QuotaBlock = {
      credentialId: 2,
      providerKey: "anthropic",
      scope: "chat",
      blockedUntilMs: clock.now + 300_000, // 5 min — expires first
    };

    const { sm, counts } = makeSM({
      accountId: "acc-1",
      mode: "subscription",
      now: () => clock.now,
      onWarning: () => {},
      onPark: () => {},
      onResume: () => { counts.resume++; },
    });

    sm.addRun("r1");
    sm.applyBlock(block1);
    sm.applyBlock(block2);

    // tick at block2 expiry (5 min) — block1 still active
    clock.now = block2.blockedUntilMs + 1;
    sm.tick();
    expect(counts.resume).toBe(0);

    // tick at block1 expiry (10 min) — all blocks expired
    clock.now = block1.blockedUntilMs + 1;
    sm.tick();
    expect(counts.resume).toBe(1);
  });

  // stale timer/generation ignored
  test("stale generation timer is ignored", () => {
    const clock = makeFakeClock(0);
    const counts: SMCounts = { warn: 0, park: 0, resume: 0 };
    let parkedRuns: string[] = [];

    const sm = new AccountStateMachine({
      accountId: "acc-1",
      mode: "metered",
      now: () => clock.now,
      onWarning: () => {},
      onPark: (runIds) => { parkedRuns = runIds; counts.park++; },
      onResume: () => {},
    });

    sm.addRun("r1");
    sm.updateMeter(1.0);
    sm.tick();
    expect(counts.park).toBe(1);
    expect(parkedRuns).toContain("r1");

    // applyBlock returns a generation token; capture it
    const staleGen = sm.applyBlock({
      credentialId: 1,
      providerKey: "openai",
      scope: "chat",
      blockedUntilMs: clock.now + 300_000,
    });

    // clear the block and re-apply — this advances generation
    sm.clearBlock(1, "openai", "chat");
    sm.applyBlock({
      credentialId: 1,
      providerKey: "openai",
      scope: "chat",
      blockedUntilMs: clock.now + 300_000,
    });

    // tick with the stale generation token — should be ignored
    sm.tick(staleGen);
    // still 1 park call — the stale gen did nothing
    expect(counts.park).toBe(1);
  });

  // manual bumpBudget for metered
  test("bumpBudget resumes metered runs and resets meter", () => {
    const clock = makeFakeClock(0);
    let resumedRuns: string[] = [];
    const { sm, counts } = makeSM({
      accountId: "acc-1",
      mode: "metered",
      now: () => clock.now,
      onWarning: () => {},
      onPark: () => { counts.park++; },
      onResume: (runIds) => { resumedRuns = runIds; counts.resume++; },
    });

    sm.addRun("r1");
    sm.addRun("r2");
    sm.updateMeter(1.0);
    sm.tick(); // parked

    expect(counts.park).toBe(1);
    expect(resumedRuns).toHaveLength(0);

    // bumpBudget resumes and resets meter
    sm.bumpBudget(0.0);

    expect(counts.resume).toBe(1);
    expect(resumedRuns).toContain("r1");
    expect(resumedRuns).toContain("r2");
  });
});

// ---------------------------------------------------------------------------
// Vixie cron DOM/DOW OR semantics
// ---------------------------------------------------------------------------

describe("Vixie cron: DOM and DOW both restricted", () => {
  // Standard Vixie cron rule:
  // - Both DOM and DOW wildcards → any day
  // - One restricted, one wildcard → restricted field must match
  // - Both restricted → day matches when EITHER field matches (OR)
  //
  // The buggy implementation uses AND for all fields.

  test("DOM=13, DOW=* → DOM must match (standard one-restricted rule)", () => {
    // Start: 2025-02-01 12:30:00 UTC. Next 13th: 2025-02-13.
    const start = new Date("2025-02-01T12:30:00Z").getTime();
    const expected = new Date("2025-02-13T00:00:00Z").getTime();
    expect(nextCronTime("0 0 13 * *", start)).toBe(expected);
  });

  test("DOM=*, DOW=Mon → DOW must match (standard one-restricted rule)", () => {
    // Start: 2025-02-01 12:30:00 UTC. Next Monday: 2025-02-03.
    const start = new Date("2025-02-01T12:30:00Z").getTime();
    const expected = new Date("2025-02-03T00:00:00Z").getTime();
    expect(nextCronTime("0 0 * * 1", start)).toBe(expected);
  });

  test("both restricted: 0 0 13 * 1 from Feb 10 → Vixie OR picks Feb 13 (Thu) earlier than next Mon Feb 17", () => {
    // Start: 2025-02-10 12:30:00 UTC.
    // Vixie OR: date=13 OR weekday=Mon. Feb 13 (date=13) < Feb 17 (next Mon).
    // Buggy AND: needs BOTH date=13 AND weekday=Mon simultaneously → first match is Oct 13.
    const start = new Date("2025-02-10T12:30:00Z").getTime();
    const expected = new Date("2025-02-13T00:00:00Z").getTime();
    expect(nextCronTime("0 0 13 * 1", start)).toBe(expected);
  });

  test("both restricted: 0 0 13 * 1 from Feb 1 → Vixie OR picks Feb 3 (Mon) earlier than next 13th Feb 13", () => {
    // Start: 2025-02-01 12:30:00 UTC.
    // Vixie OR: date=13 OR weekday=Mon. Feb 3 (Mon) < Feb 13 (date=13).
    // Buggy AND: needs BOTH → skips past all Mon 3, Mon 10, then all 13ths with wrong DOW,
    //            finally lands on Oct 13 2025 (first date that is both 13 AND Monday).
    const start = new Date("2025-02-01T12:30:00Z").getTime();
    const expected = new Date("2025-02-03T00:00:00Z").getTime();
    expect(nextCronTime("0 0 13 * 1", start)).toBe(expected);
  });
});

