import { describe, expect, test } from "bun:test";

import type { SupervisedWorker } from "../../src/daemon/supervisor";

type ContractWorker = SupervisedWorker & {
	readonly sessionId: string | undefined;
};

export interface SupervisorContractHarness {
	name: string;
	start(): Promise<ContractWorker>;
}

export function supervisorContract({
	name,
	start,
}: SupervisorContractHarness): void {
	describe(`${name} supervisor contract`, () => {
		test("preserves the common lifecycle contract", async () => {
			const worker = await start();
			const firstSessionId = worker.sessionId;
			const fingerprint = worker.fingerprint;
			expect(worker.name).toBe("reviewer");
			expect(worker.state).toBe("running");
			expect(firstSessionId).toBeTruthy();
			expect(fingerprint).toBeTruthy();

			await worker.prompt("complete this turn");
			expect(worker.state).toBe("running");

			await worker.park();
			expect(worker.state).toBe("parked");
			expect(worker.sessionId).toBeUndefined();
			expect(worker.fingerprint).toBe(fingerprint);

			await worker.resume();
			expect(worker.state).toBe("running");
			expect(worker.sessionId).toBeTruthy();
			expect(worker.sessionId).not.toBe(firstSessionId);
			expect(worker.fingerprint).toBe(fingerprint);

			await worker.stop();
			await worker.stop();
			expect(worker.state).toBe("stopped");
			expect(worker.sessionId).toBeUndefined();
			await expect(worker.prompt("after stop")).rejects.toThrow();
			await expect(worker.resume()).rejects.toThrow();
		});
	});
}
