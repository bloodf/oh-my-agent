// @module   daemon/scheduler
// @stability stable
// @since    2025-01-01
//
// Purpose:          Bounded cron-driven task scheduler with injectable clock/timers.
// Public API:       nextCronTime, Scheduler class with add/remove/start/stop.
// Upstream deps:    Date (ECMAScript), setTimeout/clearTimeout.
// Downstream deps:  quota-state (QuotaBlock re-export), daemon process manager.
// Failure modes:    Invalid cron throws synchronously; handler errors reported via onError.
// Performance:      O(iterations × 5 field-checks), capped at 10 years of minute-steps.

export type TimerHandle = unknown;

export interface SchedulerDeps {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  onError?: (error: unknown, jobId: string) => void;
}

export interface ScheduledTask {
  cron: string;
  handler: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

const MAX_ITER = 5_256_000;

export function nextCronTime(expr: string, afterMs: number): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Invalid cron expression: expected 5 fields");

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dayOfWeek = parseField(fields[4], 0, 6);

  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;

  for (let i = 0; i < MAX_ITER; i++) {
    const d = new Date(candidate);

    if (
      month.includes(d.getUTCMonth() + 1) &&
      dayOfMonth.includes(d.getUTCDate()) &&
      dayOfWeek.includes(d.getUTCDay()) &&
      hour.includes(d.getUTCHours()) &&
      minute.includes(d.getUTCMinutes())
    ) {
      d.setUTCSeconds(0, 0);
      const ts = d.getTime();
      if (ts > afterMs) return ts;
    }

    candidate += 60_000;
  }

  throw new Error("nextCronTime: exceeded 10-year iteration limit");
}

function parseField(input: string, min: number, max: number): number[] {
  const result = new Set<number>();
  let produced = false;

  for (const part of input.split(",")) {
    const slashIdx = part.indexOf("/");
    let base: string;
    let step: number | undefined;

    if (slashIdx !== -1) {
      if (part.indexOf("/", slashIdx + 1) !== -1) throw new Error(`Multiple slashes in field: ${input}`);
      base = part.slice(0, slashIdx);
      const stepStr = part.slice(slashIdx + 1);
      if (!/^\d+$/.test(stepStr)) throw new Error(`Step must be a positive integer: ${input}`);
      step = Number(stepStr);
      if (step <= 0) throw new Error(`Step must be > 0: ${input}`);
    } else {
      base = part;
    }

    if (!/^(\d+|\d+-\d+|\*)$/.test(base)) throw new Error(`Invalid field token: ${input}`);

    if (base === "*") {
      base = `${min}-${max}`;
    }

    if (base.includes("-")) {
      const [aStr, bStr] = base.split("-");
      const a = Number(aStr);
      const b = Number(bStr);
      if (isNaN(a) || isNaN(b)) throw new Error(`Non-numeric range: ${input}`);
      if (a < min || a > max || b < min || b > max) throw new Error(`Field out of range: ${input}`);
      if (b < a) throw new Error(`Reversed range: ${input}`);
      const s = step ?? 1;
      for (let v = a; v <= b; v += s) result.add(v);
      produced = true;
    } else {
      const v = Number(base);
      if (isNaN(v)) throw new Error(`Non-numeric field: ${input}`);
      if (v < min || v > max) throw new Error(`Field out of range: ${input}`);
      if (step !== undefined) throw new Error(`Step not allowed on exact value: ${input}`);
      result.add(v);
      produced = true;
    }
  }

  if (!produced) throw new Error(`Empty field result: ${input}`);
  return Array.from(result).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private globalGen = 0;
  private running = false;
  private timers = new Map<string, TimerHandle>();
  private tasks = new Map<string, ScheduledTask>();
  private versions = new Map<string, number>();

  constructor(
    private deps: SchedulerDeps = {
      now: () => Date.now(),
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  ) {
    if (!this.deps.onError) this.deps.onError = () => {};
  }

  start(): void {
    this.running = true;
    this.globalGen++;
    for (const [name, task] of this.tasks) {
      this.scheduleNext(name, task);
    }
  }

  stop(): void {
    this.running = false;
    this.globalGen++;
    for (const h of this.timers.values()) {
      this.deps.clearTimer(h);
    }
    this.timers.clear();
  }

  add(name: string, task: ScheduledTask): void {
    this.tasks.set(name, task);
    if (this.running) this.scheduleNext(name, task);
  }

  remove(name: string): void {
    const h = this.timers.get(name);
    if (h !== undefined) {
      this.deps.clearTimer(h);
      this.timers.delete(name);
    }
    this.tasks.delete(name);
    this.versions.delete(name);
  }

  private scheduleNext(name: string, task: ScheduledTask): void {
    const jobVer = (this.versions.get(name) ?? 0) + 1;
    this.versions.set(name, jobVer);

    const prev = this.timers.get(name);
    if (prev !== undefined) {
      this.deps.clearTimer(prev);
      this.timers.delete(name);
    }

    const afterMs = this.deps.now();
    const nextMs = nextCronTime(task.cron, afterMs);
    const delayMs = nextMs - afterMs;

    const tid = this.deps.setTimer(() => {
      if (!this.running) return;
      if (this.versions.get(name) !== jobVer) return;

      const onSuccess = () => {
        if (this.versions.get(name) !== jobVer) return;
        if (this.running) this.scheduleNext(name, task);
      };

      const onReject = (err: unknown) => {
        if (this.versions.get(name) !== jobVer) return;
        this.deps.onError!(err, name);
        if (this.running) this.scheduleNext(name, task);
      };

      try {
        const ret = task.handler();
        if (ret instanceof Promise) {
          void Promise.resolve(ret).then(onSuccess, onReject);
          return;
        }
      } catch (err) {
        this.deps.onError!(err, name);
      }

      onSuccess();
    }, delayMs);

    this.timers.set(name, tid);
  }
}
