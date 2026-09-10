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

/** A deadline-driven job: fires once, then retires. */
interface OneShotTask {
	atMs: number;
	handler: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

const MAX_ITER = 5_256_000;

/** Longest day each month can have; February takes its leap-year length. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The largest delay `setTimeout` can hold, in ms (2^31 - 1, about 24.8 days).
 *
 * Anything larger silently clamps to 1ms in Bun and Node, so a yearly cron
 * fired immediately, re-armed, and fired again — a hot loop burning CPU for as
 * long as the daemon lived. Longer waits are chained through this bound
 * instead.
 */
const MAX_TIMER_MS = 2_147_483_647;

export function nextCronTime(expr: string, afterMs: number): number {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5)
		throw new Error("Invalid cron expression: expected 5 fields");

	const minuteField = fields[0];
	const hourField = fields[1];
	const dayOfMonthField = fields[2];
	const monthField = fields[3];
	const dayOfWeekField = fields[4];
	const minute = parseField(minuteField, 0, 59);
	const hour = parseField(hourField, 0, 23);
	const dayOfMonth = parseField(dayOfMonthField, 1, 31);
	const month = parseField(monthField, 1, 12);
	const dayOfWeek = parseField(dayOfWeekField, 0, 6);
	const dayOfMonthWildcard = dayOfMonthField === "*";
	const dayOfWeekWildcard = dayOfWeekField === "*";

	// Refuse a date that no calendar can produce — `0 0 30 2 *` is the classic
	// one — before walking toward it a minute at a time. The scan below is
	// synchronous and ten years long, so an unsatisfiable expression froze the
	// daemon for seconds during `armCron` at boot and then threw anyway.
	// Only when the day-of-week field is a wildcard: otherwise the two day
	// fields are an OR, and a weekday can still match.
	if (!dayOfMonthWildcard && dayOfWeekWildcard) {
		const reachable = month.some((m) =>
			dayOfMonth.some((day) => day <= DAYS_IN_MONTH[m - 1]),
		);
		if (!reachable) {
			throw new Error(`Invalid cron expression: ${expr} never occurs`);
		}
	}

	let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;

	for (let i = 0; i < MAX_ITER; i++) {
		const d = new Date(candidate);
		const dayOfMonthMatches = dayOfMonth.includes(d.getUTCDate());
		const dayOfWeekMatches = dayOfWeek.includes(d.getUTCDay());
		const dayMatches =
			dayOfMonthWildcard && dayOfWeekWildcard
				? true
				: dayOfMonthWildcard
					? dayOfWeekMatches
					: dayOfWeekWildcard
						? dayOfMonthMatches
						: dayOfMonthMatches || dayOfWeekMatches;

		if (
			month.includes(d.getUTCMonth() + 1) &&
			dayMatches &&
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
			if (part.indexOf("/", slashIdx + 1) !== -1)
				throw new Error(`Multiple slashes in field: ${input}`);
			base = part.slice(0, slashIdx);
			const stepStr = part.slice(slashIdx + 1);
			if (!/^\d+$/.test(stepStr))
				throw new Error(`Step must be a positive integer: ${input}`);
			step = Number(stepStr);
			if (step <= 0) throw new Error(`Step must be > 0: ${input}`);
		} else {
			base = part;
		}

		if (!/^(\d+|\d+-\d+|\*)$/.test(base))
			throw new Error(`Invalid field token: ${input}`);

		if (base === "*") {
			base = `${min}-${max}`;
		}

		if (base.includes("-")) {
			const [aStr, bStr] = base.split("-");
			const a = Number(aStr);
			const b = Number(bStr);
			if (Number.isNaN(a) || Number.isNaN(b))
				throw new Error(`Non-numeric range: ${input}`);
			if (a < min || a > max || b < min || b > max)
				throw new Error(`Field out of range: ${input}`);
			if (b < a) throw new Error(`Reversed range: ${input}`);
			const s = step ?? 1;
			for (let v = a; v <= b; v += s) result.add(v);
			produced = true;
		} else {
			const v = Number(base);
			if (Number.isNaN(v)) throw new Error(`Non-numeric field: ${input}`);
			if (v < min || v > max) throw new Error(`Field out of range: ${input}`);
			if (step !== undefined)
				throw new Error(`Step not allowed on exact value: ${input}`);
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
	private running = false;
	private timers = new Map<string, TimerHandle>();
	private tasks = new Map<string, ScheduledTask>();
	private onceTasks = new Map<string, OneShotTask>();
	private versions = new Map<string, number>();

	constructor(
		private deps: SchedulerDeps = {
			now: () => Date.now(),
			setTimer: (cb, ms) => setTimeout(cb, ms),
			clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		},
	) {}

	start(): void {
		this.running = true;
		for (const [name, task] of this.tasks) {
			this.scheduleNext(name, task);
		}
		for (const [name, task] of this.onceTasks) {
			this.scheduleOnce(name, task);
		}
	}

	stop(): void {
		this.running = false;
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
		this.onceTasks.delete(name);
		this.versions.delete(name);
	}

	/**
	 * Fire `handler` once at `atMs`, then retire the job. Used for quota
	 * auto-resume, where the deadline comes from a verified `blockedUntilMs`
	 * rather than a recurring expression. A deadline already in the past fires
	 * on the next tick instead of being dropped.
	 */
	addOnce(
		name: string,
		atMs: number,
		handler: () => void | Promise<void>,
	): void {
		const task: OneShotTask = { atMs, handler };
		this.onceTasks.set(name, task);
		if (this.running) this.scheduleOnce(name, task);
	}

	private scheduleOnce(name: string, task: OneShotTask): void {
		const jobVer = (this.versions.get(name) ?? 0) + 1;
		this.versions.set(name, jobVer);

		const prev = this.timers.get(name);
		if (prev !== undefined) {
			this.deps.clearTimer(prev);
			this.timers.delete(name);
		}

		this.armAt(name, jobVer, task.atMs, () => {
			if (!this.running) return;
			if (this.versions.get(name) !== jobVer) return;

			// Retire before running: a one-shot never re-arms, and the handler may
			// schedule its own successor under the same name.
			this.timers.delete(name);
			this.onceTasks.delete(name);

			try {
				const ret = task.handler();
				if (ret instanceof Promise) {
					void ret.catch((err: unknown) => this.deps.onError?.(err, name));
				}
			} catch (err) {
				this.deps.onError?.(err, name);
			}
		});
	}

	/**
	 * Arm `fire` for an absolute instant, chaining through `MAX_TIMER_MS`.
	 *
	 * A delay past that bound clamps to 1ms rather than waiting, so a yearly
	 * cron or a far-future quota resume fired at once and re-armed forever.
	 * Each hop recomputes the remaining time from `atMs` rather than
	 * subtracting a fixed step, so a suspended machine resumes on the real
	 * deadline instead of one shifted by however long it slept.
	 */
	private armAt(
		name: string,
		jobVer: number,
		atMs: number,
		fire: () => void,
	): void {
		const delayMs = Math.max(0, atMs - this.deps.now());
		if (delayMs > MAX_TIMER_MS) {
			this.timers.set(
				name,
				this.deps.setTimer(() => {
					if (!this.running) return;
					if (this.versions.get(name) !== jobVer) return;
					this.armAt(name, jobVer, atMs, fire);
				}, MAX_TIMER_MS),
			);
			return;
		}
		this.timers.set(name, this.deps.setTimer(fire, delayMs));
	}

	private scheduleNext(name: string, task: ScheduledTask): void {
		const jobVer = (this.versions.get(name) ?? 0) + 1;
		this.versions.set(name, jobVer);

		const prev = this.timers.get(name);
		if (prev !== undefined) {
			this.deps.clearTimer(prev);
			this.timers.delete(name);
		}

		const nextMs = nextCronTime(task.cron, this.deps.now());

		this.armAt(name, jobVer, nextMs, () => {
			if (!this.running) return;
			if (this.versions.get(name) !== jobVer) return;

			const onSuccess = () => {
				if (this.versions.get(name) !== jobVer) return;
				if (this.running) this.scheduleNext(name, task);
			};

			const onReject = (err: unknown) => {
				if (this.versions.get(name) !== jobVer) return;
				this.deps.onError?.(err, name);
				if (this.running) this.scheduleNext(name, task);
			};

			try {
				const ret = task.handler();
				if (ret instanceof Promise) {
					void Promise.resolve(ret).then(onSuccess, onReject);
					return;
				}
			} catch (err) {
				this.deps.onError?.(err, name);
			}

			onSuccess();
		});
	}
}
