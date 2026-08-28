/**
 * Contract suite for the daemon control-socket protocol (T-507).
 *
 * Pins the wire shape that the daemon server (T-502), the worker toolbelt
 * (T-503), and the TUI client (T-504) are all written against: the exact
 * method set, per-method params/result validation, the error shape carrying
 * the protocol version, and the module's transport-free purity.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	ERROR_CODE,
	invalidParams,
	METHOD_NAMES,
	methodNotFound,
	PROTOCOL_VERSION,
} from "../src/shared/protocol";
import { METHODS } from "../src/shared/protocol-schemas";

// ---------------------------------------------------------------------------
// Valid fixtures, one per method. A method without a fixture fails to compile,
// which is the point: the declared set and the exercised set cannot drift.
// ---------------------------------------------------------------------------

const VALID_PARAMS: Record<(typeof METHOD_NAMES)[number], unknown> = {
	status: {},
	chat_send: { room: "#reviews", body: "looks good", author: "@you" },
	chat_read: { room: "#reviews", sinceId: 41, limit: 50 },
	chat_wait: { room: "#reviews", sinceId: 41, timeoutMs: 5000 },
	agent_spawn: { name: "researcher", rooms: ["#research"], cwd: "/tmp/proj" },
	agent_status: { name: "researcher" },
	task_handoff: {
		fromAgent: "researcher",
		toAgent: "reviewer",
		summary: "findings ready",
		artifacts: ["#research:41"],
	},
	rooms_list: {},
	rooms_post: { room: "#reviews", body: "shipping", author: "@you" },
	schedules_list: {},
	schedules_arm: { scheduleId: "sched-1", enabled: true },
	kill: { name: "researcher" },
	bump: { account: "acct-1", budgetUsd: 5 },
};

const VALID_RESULTS: Record<(typeof METHOD_NAMES)[number], unknown> = {
	status: { protocolVersion: PROTOCOL_VERSION, agents: [], uptimeMs: 12 },
	chat_send: { messageId: 42, createdAt: 1750000000000 },
	chat_read: { messages: [] },
	chat_wait: { messages: [] },
	agent_spawn: { name: "researcher", state: "running" },
	agent_status: {
		agents: [{ name: "researcher", state: "parked", account: "acct-1" }],
	},
	task_handoff: { handoffId: "handoff-1" },
	rooms_list: {
		rooms: [{ id: "#reviews", kind: "channel", name: "#reviews" }],
	},
	rooms_post: { messageId: 43, createdAt: 1750000000000 },
	schedules_list: {
		schedules: [
			{
				id: "sched-1",
				cron: "*/10 * * * *",
				action: "wake:researcher",
				nextFireAt: 1750000000000,
				enabled: true,
			},
		],
	},
	schedules_arm: {
		schedule: {
			id: "sched-1",
			cron: null,
			action: "wake:researcher",
			nextFireAt: null,
			enabled: true,
		},
	},
	kill: { name: "researcher", state: "stopped" },
	bump: { account: "acct-1", budgetUsd: 5, resumed: ["researcher"] },
};

// ---------------------------------------------------------------------------
// Method set and version
// ---------------------------------------------------------------------------

describe("declared method set", () => {
	test("is exactly the thirteen contracted methods", () => {
		expect(([...METHOD_NAMES] as string[]).sort()).toEqual(
			[
				"agent_spawn",
				"agent_status",
				"bump",
				"chat_read",
				"chat_send",
				"chat_wait",
				"kill",
				"rooms_list",
				"rooms_post",
				"schedules_arm",
				"schedules_list",
				"status",
				"task_handoff",
			].sort(),
		);
	});

	test("every declared method has params and result validators registered", () => {
		for (const name of METHOD_NAMES) {
			const entry = METHODS[name];
			expect(entry).toBeDefined();
			expect(typeof entry.validateParams).toBe("function");
			expect(typeof entry.validateResult).toBe("function");
		}
	});

	test("PROTOCOL_VERSION is a positive integer", () => {
		expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
		expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

describe("params validation", () => {
	test("every method accepts its valid fixture", () => {
		for (const name of METHOD_NAMES) {
			const result = METHODS[name].validateParams(VALID_PARAMS[name]);
			expect(result.ok).toBe(true);
		}
	});

	test("every method rejects a non-object params payload with a field named", () => {
		for (const name of METHOD_NAMES) {
			const result = METHODS[name].validateParams(42);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(typeof result.field).toBe("string");
		}
	});

	test("a malformed field is refused with the offending field named", () => {
		const result = METHODS.chat_send.validateParams({ room: 7, body: "x" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toBe("room");
	});

	test("optional fields may be omitted", () => {
		expect(METHODS.chat_read.validateParams({ room: "#a" }).ok).toBe(true);
		expect(METHODS.agent_status.validateParams({}).ok).toBe(true);
	});

	test("wrongly typed optional fields are refused", () => {
		const result = METHODS.chat_read.validateParams({
			room: "#a",
			limit: "50",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toBe("limit");
	});

	test("no-params methods reject unexpected keys, naming the params side", () => {
		for (const name of ["status", "rooms_list", "schedules_list"] as const) {
			const result = METHODS[name].validateParams({ verbose: true });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("params");
		}
	});
});

describe("result validation", () => {
	test("every method accepts its valid result fixture", () => {
		for (const name of METHOD_NAMES) {
			const result = METHODS[name].validateResult(VALID_RESULTS[name]);
			expect(result.ok).toBe(true);
		}
	});

	test("a result missing a required field fails with the field named", () => {
		const result = METHODS.status.validateResult({
			protocolVersion: PROTOCOL_VERSION,
			uptimeMs: 3,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toBe("agents");
	});

	test("nested message entries are validated", () => {
		const result = METHODS.chat_read.validateResult({
			messages: [
				{
					id: "not-a-number",
					room: "#a",
					author: "x",
					body: "y",
					createdAt: 1,
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toContain("id");
	});
});

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

describe("error shape", () => {
	test("unknown method yields method-not-found carrying the protocol version", () => {
		const failure = methodNotFound("req-1", "definitely_not_a_method");
		expect(failure.jsonrpc).toBe("2.0");
		expect(failure.id).toBe("req-1");
		expect(failure.error.code).toBe(ERROR_CODE.METHOD_NOT_FOUND);
		expect(failure.error.data.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(failure.error.message).toContain("definitely_not_a_method");
	});

	test("invalid params carries the version and the offending field", () => {
		const failure = invalidParams(7, "room", "room must be a non-empty string");
		expect(failure.error.code).toBe(ERROR_CODE.INVALID_PARAMS);
		expect(failure.error.data.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(failure.error.data.field).toBe("room");
	});
});

// ---------------------------------------------------------------------------
// Purity: the contract module touches no transport and no daemon state
// ---------------------------------------------------------------------------

describe("transport-free contract", () => {
	test("protocol sources import no I/O or daemon modules", () => {
		const forbidden = [
			"node:net",
			"node:fs",
			"node:child_process",
			"node:dgram",
			"bun:",
			"Bun.",
			"daemon/",
			"rooms/",
			"worker/",
		];
		for (const file of ["protocol.ts", "protocol-schemas.ts"]) {
			const source = readFileSync(
				join(import.meta.dir, "..", "src", "shared", file),
				"utf8",
			);
			for (const marker of forbidden) {
				expect(source.includes(marker)).toBe(false);
			}
		}
	});
});
