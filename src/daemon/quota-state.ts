// @module   daemon/quota-state
// @stability stable
// @since    2025-01-01
//
// Purpose:          Per-account quota enforcement state machine with generation guards.
// Public API:       QuotaBlock interface, AccountStateMachine class.
// Upstream deps:    none.
// Downstream deps:  scheduler (re-exports QuotaBlock), daemon process manager.
// Failure modes:    Invalid meter value (non-finite or out of [0,1]), empty runId.
// Performance:      O(blocks) per tick; tick is O(n) where n = active blocks.

export interface QuotaBlock {
	credentialId: number;
	providerKey: string;
	scope: string;
	blockedUntilMs: number;
}

export interface AccountSMDep {
	accountId: string;
	mode: "metered" | "subscription";
	now: () => number;
	onWarning: () => void;
	onPark: (runIds: string[]) => void;
	onResume: (runIds: string[]) => void;
}

export class AccountStateMachine {
	private generation = 0;
	private runs = new Set<string>();
	private meter = 0;
	private warned = false;
	private parked = false;
	private blocks: QuotaBlock[] = [];
	private parkedRuns: string[] = [];

	constructor(private dep: AccountSMDep) {}

	addRun(runId: string): void {
		if (!runId) throw new Error("runId must be non-empty");
		this.runs.add(runId);
	}

	removeRun(runId: string): void {
		this.runs.delete(runId);
		this.parkedRuns = this.parkedRuns.filter((id) => id !== runId);
	}

	updateMeter(value: number): void {
		if (!Number.isFinite(value)) throw new Error("Meter value must be finite");
		if (value < 0 || value > 1)
			throw new Error("Meter value must be between 0 and 1");
		this.meter = value;
	}

	applyBlock(block: QuotaBlock): number {
		this.generation++;

		const idx = this.blocks.findIndex(
			(b) =>
				b.credentialId === block.credentialId &&
				b.providerKey === block.providerKey &&
				b.scope === block.scope,
		);

		if (idx !== -1) {
			if (block.blockedUntilMs > this.blocks[idx].blockedUntilMs) {
				this.blocks[idx] = block;
			}
		} else {
			this.blocks.push(block);
		}

		if (
			this.dep.mode === "subscription" &&
			!this.parked &&
			this.runs.size > 0
		) {
			this.parkedRuns = Array.from(this.runs);
			this.parked = true;
			this.dep.onPark(this.parkedRuns);
		}

		return this.generation;
	}

	clearBlock(credentialId: number, providerKey: string, scope: string): void {
		this.generation++;
		this.blocks = this.blocks.filter(
			(b) =>
				!(
					b.credentialId === credentialId &&
					b.providerKey === providerKey &&
					b.scope === scope
				),
		);
	}

	/**
	 * Latest deadline among still-active blocks, or `undefined` when none is
	 * active. A resume must be armed for this instant: firing at an earlier
	 * block's deadline would find a later block still active, retire the timer,
	 * and leave the account parked forever.
	 */
	activeUntilMs(): number | undefined {
		const now = this.dep.now();
		let latest: number | undefined;
		for (const block of this.blocks) {
			if (block.blockedUntilMs <= now) continue;
			if (latest === undefined || block.blockedUntilMs > latest)
				latest = block.blockedUntilMs;
		}
		return latest;
	}

	tick(generation?: number): void {
		if (generation !== undefined && generation !== this.generation) return;

		const now = this.dep.now();

		if (this.dep.mode === "metered" && !this.parked) {
			if (this.meter >= 1.0) {
				this.parkedRuns = Array.from(this.runs);
				if (this.parkedRuns.length > 0) this.dep.onPark(this.parkedRuns);
				this.parked = true;
			} else if (this.meter >= 0.8 && !this.warned) {
				this.dep.onWarning();
				this.warned = true;
			}
		}

		if (this.dep.mode === "subscription" && this.parked) {
			const hasActive = this.blocks.some((b) => now < b.blockedUntilMs);
			if (!hasActive) {
				if (this.parkedRuns.length > 0) {
					this.dep.onResume(this.parkedRuns);
				}
				this.parked = false;
				this.parkedRuns = [];
				this.blocks = [];
			}
		}
	}

	bumpBudget(meter: number): void {
		if (!Number.isFinite(meter)) throw new Error("Meter must be finite");
		if (meter < 0 || meter > 1)
			throw new Error("Meter must be between 0 and 1");

		this.generation++;
		this.meter = meter;
		this.warned = false;

		if (this.parked) {
			this.parked = false;
			const runs = Array.from(this.runs);
			if (runs.length > 0) this.dep.onResume(runs);
			this.parkedRuns = [];
		}
	}
}
