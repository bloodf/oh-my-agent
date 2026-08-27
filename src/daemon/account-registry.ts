/**
 * Purpose: Own quota state per *account* (§9.4) and make its handling
 * autonomous — a subscription block arms its own one-shot resume timer from
 * the verified `blockedUntilMs`, so work continues with no human in the loop.
 * Also owns the wake path: a wake for a parked account is refused rather than
 * burning a turn that would immediately fail.
 *
 * Public API: `AccountRegistry`.
 *
 * Upstream deps: `./quota-state` (`AccountStateMachine`, `QuotaBlock`),
 * `./scheduler` (`Scheduler.addOnce`).
 *
 * Downstream consumers: the room bus (wake on mention), the worker lifecycle
 * (park/resume), and the credential gateway's block route.
 *
 * Failure modes: a block or run for an unregistered account throws — silently
 * creating one would hide a mis-wired account id and lose its billing mode.
 * Metered exhaustion deliberately arms no timer; it needs a human bump.
 *
 * Performance: one state machine and at most one pending timer per account.
 */
import { AccountStateMachine } from "./quota-state";
import type { QuotaBlock } from "./quota-state";
import type { Scheduler } from "./scheduler";

export type AccountMode = "metered" | "subscription";

export interface AccountRegistryDeps {
	scheduler: Scheduler;
	now: () => number;
	/** Runs suspended because their account ran out of quota. */
	onPark: (accountId: string, runIds: string[]) => void;
	/** Runs cleared to continue after a bump or an auto-resume. */
	onResume: (accountId: string, runIds: string[]) => void;
	/** Metered account crossed 80% of its budget. */
	onWarning: (accountId: string) => void;
	/** Deliver pending work to a parked worker. */
	onWake: (runId: string) => void;
}

interface AccountEntry {
	machine: AccountStateMachine;
	mode: AccountMode;
	parked: boolean;
}

export class AccountRegistry {
	#accounts = new Map<string, AccountEntry>();

	constructor(private deps: AccountRegistryDeps) {}

	/** Idempotent: re-registering keeps the existing machine and its state. */
	register(accountId: string, mode: AccountMode): void {
		if (this.#accounts.has(accountId)) return;

		const entry: AccountEntry = {
			mode,
			parked: false,
			machine: new AccountStateMachine({
				accountId,
				mode,
				now: this.deps.now,
				onWarning: () => this.deps.onWarning(accountId),
				onPark: (runIds) => {
					entry.parked = true;
					this.deps.onPark(accountId, runIds);
				},
				onResume: (runIds) => {
					entry.parked = false;
					this.deps.onResume(accountId, runIds);
				},
			}),
		};
		this.#accounts.set(accountId, entry);
	}

	addRun(accountId: string, runId: string): void {
		this.#require(accountId).machine.addRun(runId);
	}

	removeRun(accountId: string, runId: string): void {
		this.#require(accountId).machine.removeRun(runId);
	}

	isParked(accountId: string): boolean {
		return this.#accounts.get(accountId)?.parked ?? false;
	}

	/**
	 * Record a quota block and, for a subscription account, arm the resume.
	 * The timer carries the generation the block produced, so a later block
	 * supersedes it: firing a stale timer is a no-op inside the machine.
	 */
	applyBlock(accountId: string, block: QuotaBlock): void {
		const entry = this.#require(accountId);
		const generation = entry.machine.applyBlock(block);
		if (entry.mode !== "subscription") return;

		// Arm for the LATEST active deadline, not this block's. With two active
		// blocks, firing at the earlier one would find the later still active,
		// retire the timer, and strand the account parked forever.
		const deadline = entry.machine.activeUntilMs();
		if (deadline === undefined) return;

		// Same job name per account, so re-arming replaces the pending deadline.
		this.deps.scheduler.addOnce(`quota-resume:${accountId}`, deadline, () => {
			entry.machine.tick(generation);
		});
	}

	/** Metered progress: warns at 80%, parks at 100%. Arms no timer. */
	updateMeter(accountId: string, meter: number): void {
		const entry = this.#require(accountId);
		entry.machine.updateMeter(meter);
		entry.machine.tick();
	}

	/** Human budget bump: resumes a parked metered account immediately. */
	bumpBudget(accountId: string, meter: number): void {
		this.#require(accountId).machine.bumpBudget(meter);
	}

	/**
	 * Deliver pending work to a worker. Refused while the account is parked —
	 * the message waits for the armed resume instead of burning a turn that
	 * would fail on the first model call.
	 */
	wake(accountId: string, runId: string): boolean {
		const entry = this.#accounts.get(accountId);
		if (!entry || entry.parked) return false;
		this.deps.onWake(runId);
		return true;
	}

	#require(accountId: string): AccountEntry {
		const entry = this.#accounts.get(accountId);
		if (!entry) throw new Error(`Unknown account: ${accountId}`);
		return entry;
	}
}
