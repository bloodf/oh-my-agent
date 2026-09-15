/**
 * `collectSetupReport`: the checklist behind `/setup` and `omp-agent setup`,
 * driven through a stand-in client so each daemon answer is chosen here.
 */
import { describe, expect, test } from "bun:test";
import type { AgentStatus, MethodName } from "../src/shared/protocol";
import {
	CREW,
	collectSetupReport,
	type SetupClient,
} from "../src/shared/setup-report";

function client(
	agents: AgentStatus[],
	version = "1.2.3",
): SetupClient & { calls: MethodName[] } {
	const calls: MethodName[] = [];
	const answers: Partial<Record<MethodName, unknown>> = {
		status: { version, agents },
		models_list: {
			models: [{ id: "p/m" }],
			default: "p/m",
			defaultRoutable: true,
		},
		rooms_list: { rooms: [{ id: "#bridge" }, { id: "#team" }] },
	};
	return {
		calls,
		async call<T>(method: MethodName): Promise<T> {
			calls.push(method);
			if (!(method in answers)) throw new Error(`unexpected ${method}`);
			return answers[method] as T;
		},
	};
}

const running = (name: string): AgentStatus => ({
	name,
	state: "running",
	account: "acct",
});

describe("setup report", () => {
	test("a fully running crew is ready", async () => {
		const report = await collectSetupReport(client(CREW.map(running)), "1.2.3");
		expect(report.ready).toBe(true);
		expect(report.parkedCrew).toEqual([]);
	});

	test("a parked crew peer is reported with the bump hint and blocks ready", async () => {
		const agents = CREW.map(running);
		agents[1] = { name: CREW[1], state: "parked", account: "metered" };
		const report = await collectSetupReport(client(agents), "1.2.3");
		expect(report.ready).toBe(false);
		expect(report.parkedCrew.map((agent) => agent.name)).toEqual([CREW[1]]);
		expect(report.lines).toContain(
			`✗ ${CREW[1]} parked: account metered is out of budget — /cli bump metered <usd>`,
		);
	});

	test("version drift names the right direction", async () => {
		const agents = CREW.map(running);
		const older = await collectSetupReport(client(agents, "1.2.3"), "1.10.0");
		expect(older.lines[0]).toBe(
			"✗ daemon 1.2.3 is older than this plugin 1.10.0 — /cli daemon restart",
		);
		const newer = await collectSetupReport(client(agents, "1.10.0"), "1.2.3");
		expect(newer.lines[0]).toBe(
			"✗ daemon 1.10.0 is newer than this plugin 1.2.3 — /cli daemon restart",
		);
		expect(newer.ready).toBe(false);
	});
});
