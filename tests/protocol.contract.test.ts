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

const VALID_PEER_DEFINITION = {
	name: "researcher",
	description: "Investigates codebases and reports findings.",
	tools: ["read", "grep"],
	model: ["sonnet"],
	thinkingLevel: "medium",
	blocking: false,
	autoloadSkills: ["dinostack"],
	readSummarize: true,
	prewalk: false,
	advisor: false,
	spawns: ["#research"],
	body: "You are the researcher. Investigate and report findings.",
	workspace: "/tmp/proj",
	rooms: ["#research"],
	wake: { mention: true, rooms: false },
	autonomy: { maxTurns: 10, budgetUsd: 5 },
	sandbox: { enabled: true, extraRoots: ["/tmp/proj"] },
	mcps: ["github"],
	skills: ["dinostack"],
	schedules: [
		{
			cron: "*/10 * * * *",
			prompt: "check for new findings",
			room: "#research",
		},
	],
	automations: [
		{ event: "on_mention", prompt: "respond promptly", room: "#research" },
	],
	sha256: "a".repeat(64),
};

const DEFINITION_FILE_PATH = "/agents/researcher.md";

const VALID_PARAMS: Record<(typeof METHOD_NAMES)[number], unknown> = {
	status: {},
	chat_send: { room: "#reviews", body: "looks good", author: "@you" },
	chat_read: { room: "#reviews", sinceId: 41, limit: 50 },
	chat_wait: { room: "#reviews", sinceId: 41, timeoutMs: 5000 },
	chat_react: { messageId: 42, actor: "reviewer", emoji: "👀" },
	chat_unreact: { messageId: 42, actor: "reviewer", emoji: "👀" },
	agent_spawn: {
		name: "researcher",
		rooms: ["#research"],
		cwd: "/tmp/proj",
		parent: "orchestrator",
	},
	agent_status: { name: "researcher" },
	agent_create: {
		name: "researcher",
		description: "Investigates codebases and reports findings.",
		model: ["sonnet"],
		rooms: ["#research"],
		wake: { mention: true, rooms: false },
		autonomy: { maxTurns: 10, budgetUsd: 5 },
		spawns: ["#research"],
		body: "You are the researcher. Investigate and report findings.",
	},
	definition_get: { name: "researcher" },
	definition_update: {
		name: "researcher",
		changes: { description: "Updated description", autonomy: { maxTurns: 20 } },
	},
	logs_tail: { name: "researcher", lines: 50 },
	inject: { name: "researcher", message: "prioritize the failing test" },
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
	daemon_stop: {},
};

const VALID_RESULTS: Record<(typeof METHOD_NAMES)[number], unknown> = {
	status: { protocolVersion: PROTOCOL_VERSION, agents: [], uptimeMs: 12 },
	chat_send: { messageId: 42, createdAt: 1750000000000 },
	chat_read: {
		messages: [
			{
				id: 42,
				room: "#reviews",
				author: "reviewer",
				body: "looks good",
				createdAt: 1750000000000,
				parentId: null,
				threadRootId: null,
				replyCount: 0,
				reactions: [{ actor: "reviewer", emoji: "👀" }],
			},
		],
	},
	chat_wait: { messages: [] },
	chat_react: { messageId: 42, actor: "reviewer", emoji: "👀", added: true },
	chat_unreact: {
		messageId: 42,
		actor: "reviewer",
		emoji: "👀",
		removed: true,
	},
	agent_spawn: { name: "researcher", state: "running" },
	agent_status: {
		agents: [
			{
				name: "researcher",
				state: "parked",
				account: "acct-1",
				parent: "orchestrator",
				children: ["intern-1"],
			},
		],
	},
	agent_create: { name: "researcher", created: true },
	definition_get: {
		name: "researcher",
		filePath: DEFINITION_FILE_PATH,
		definition: VALID_PEER_DEFINITION,
	},
	definition_update: { name: "researcher", rebuildRequired: true },
	logs_tail: { name: "researcher", lines: ["first", "second"] },
	inject: { name: "researcher", queued: false },
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
	daemon_stop: { stopping: true, pid: 4242 },
};

// ---------------------------------------------------------------------------
// Method set and version
// ---------------------------------------------------------------------------

describe("declared method set", () => {
	test("is exactly the twenty-one contracted methods", () => {
		expect(([...METHOD_NAMES] as string[]).sort()).toEqual(
			[
				"agent_create",
				"agent_spawn",
				"agent_status",
				"bump",
				"chat_react",
				"chat_read",
				"chat_send",
				"chat_unreact",
				"chat_wait",
				"daemon_stop",
				"definition_get",
				"definition_update",
				"kill",
				"inject",
				"rooms_list",
				"logs_tail",
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

	test("steering params validate line limits and non-empty messages", () => {
		for (const lines of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const result = METHODS.logs_tail.validateParams({
				name: "researcher",
				lines,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("lines");
		}

		const missingMessage = METHODS.inject.validateParams({
			name: "researcher",
		});
		expect(missingMessage.ok).toBe(false);
		if (!missingMessage.ok) expect(missingMessage.field).toBe("message");

		const emptyMessage = METHODS.inject.validateParams({
			name: "researcher",
			message: "",
		});
		expect(emptyMessage.ok).toBe(false);
		if (!emptyMessage.ok) expect(emptyMessage.field).toBe("message");
	});

	test("logs_tail source selects a stream and refuses anything else", () => {
		// Omitted is the default and means worker stderr — every client
		// predating daemon logs sends exactly this.
		expect(METHODS.logs_tail.validateParams({ name: "researcher" }).ok).toBe(
			true,
		);
		for (const source of ["worker", "daemon"] as const) {
			expect(
				METHODS.logs_tail.validateParams({ name: "researcher", source }).ok,
			).toBe(true);
		}

		// A near-miss spelling must be refused rather than silently defaulting
		// to worker stderr: an operator asking for daemon logs and getting a
		// peer's would have no way to tell.
		for (const source of ["Daemon", "daemons", "", "all", 7, null, true]) {
			const result = METHODS.logs_tail.validateParams({
				name: "researcher",
				source,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("source");
		}
	});

	test("reaction params require messageId, actor, and emoji", () => {
		for (const method of ["chat_react", "chat_unreact"] as const) {
			for (const [field, params] of [
				["messageId", { actor: "reviewer", emoji: "👀" }],
				["messageId", { messageId: "42", actor: "reviewer", emoji: "👀" }],
				["actor", { messageId: 42, emoji: "👀" }],
				["actor", { messageId: 42, actor: "", emoji: "👀" }],
				["emoji", { messageId: 42, actor: "reviewer" }],
				["emoji", { messageId: 42, actor: "reviewer", emoji: "" }],
			] as const) {
				const result = METHODS[method].validateParams(params);
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.field).toBe(field);
			}
		}
	});

	test("reaction params require a positive safe integer messageId", () => {
		for (const method of ["chat_react", "chat_unreact"] as const) {
			for (const messageId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				const result = METHODS[method].validateParams({
					messageId,
					actor: "reviewer",
					emoji: "👀",
				});
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.field).toBe("messageId");
			}
		}
	});

	test("no-params methods reject unexpected keys, naming the params side", () => {
		for (const name of ["status", "rooms_list", "schedules_list"] as const) {
			const result = METHODS[name].validateParams({ verbose: true });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("params");
		}
	});

	test("agent_spawn accepts an optional parent, refusing a wrong type", () => {
		expect(
			METHODS.agent_spawn.validateParams({
				name: "researcher",
				parent: "orchestrator",
			}).ok,
		).toBe(true);
		const result = METHODS.agent_spawn.validateParams({
			name: "researcher",
			parent: 7,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toBe("parent");
	});

	test("agent_create requires name/description/body, naming malformed authoring fields", () => {
		expect(
			METHODS.agent_create.validateParams({
				name: "researcher",
				description: "Investigates codebases and reports findings.",
				model: ["sonnet"],
				rooms: ["#research"],
				wake: { mention: true, rooms: false },
				autonomy: { maxTurns: 10, budgetUsd: 5 },
				spawns: ["#research"],
				body: "You are the researcher. Investigate and report findings.",
			}).ok,
		).toBe(true);

		const wrongName = METHODS.agent_create.validateParams({
			name: 7,
			description: "x",
			body: "y",
		});
		expect(wrongName.ok).toBe(false);
		if (!wrongName.ok) expect(wrongName.field).toBe("name");

		const missingDescription = METHODS.agent_create.validateParams({
			name: "researcher",
			body: "y",
		});
		expect(missingDescription.ok).toBe(false);
		if (!missingDescription.ok)
			expect(missingDescription.field).toBe("description");

		const missingBody = METHODS.agent_create.validateParams({
			name: "researcher",
			description: "x",
		});
		expect(missingBody.ok).toBe(false);
		if (!missingBody.ok) expect(missingBody.field).toBe("body");

		const badWake = METHODS.agent_create.validateParams({
			name: "researcher",
			description: "x",
			body: "y",
			wake: { mention: "yes" },
		});
		expect(badWake.ok).toBe(false);
		if (!badWake.ok) expect(badWake.field).toBe("wake.mention");

		const badAutonomy = METHODS.agent_create.validateParams({
			name: "researcher",
			description: "x",
			body: "y",
			autonomy: { maxTurns: "many" },
		});
		expect(badAutonomy.ok).toBe(false);
		if (!badAutonomy.ok) expect(badAutonomy.field).toBe("autonomy.maxTurns");

		for (const field of ["tools", "sha256"] as const) {
			const result = METHODS.agent_create.validateParams({
				name: "researcher",
				description: "x",
				body: "y",
				[field]: field === "tools" ? ["read"] : "a".repeat(64),
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe(field);
		}
	});

	test("definition_get requires a non-empty name", () => {
		expect(
			METHODS.definition_get.validateParams({ name: "researcher" }).ok,
		).toBe(true);
		const result = METHODS.definition_get.validateParams({ name: "" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.field).toBe("name");
	});

	test("definition_update requires name and a valid changes object, naming nested fields", () => {
		expect(
			METHODS.definition_update.validateParams({
				name: "researcher",
				changes: { description: "new" },
			}).ok,
		).toBe(true);

		const missingChanges = METHODS.definition_update.validateParams({
			name: "researcher",
		});
		expect(missingChanges.ok).toBe(false);
		if (!missingChanges.ok) expect(missingChanges.field).toBe("changes");

		const badNestedField = METHODS.definition_update.validateParams({
			name: "researcher",
			changes: { autonomy: { maxTurns: "many" } },
		});
		expect(badNestedField.ok).toBe(false);
		if (!badNestedField.ok) {
			expect(badNestedField.field).toBe("changes.autonomy.maxTurns");
		}

		for (const field of ["name", "sha256"] as const) {
			const result = METHODS.definition_update.validateParams({
				name: "researcher",
				changes: { [field]: "forbidden" },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe(`changes.${field}`);
		}
	});

	test("daemon_stop takes no params and names the offending key", () => {
		expect(METHODS.daemon_stop.validateParams({}).ok).toBe(true);

		const extra = METHODS.daemon_stop.validateParams({ force: true });
		expect(extra.ok).toBe(false);
		if (!extra.ok) {
			expect(extra.field).toBe("params");
			expect(extra.message).toContain("force");
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

	test("reaction results require actor and the method-specific outcome", () => {
		const missingActor = METHODS.chat_react.validateResult({
			messageId: 42,
			emoji: "👀",
			added: true,
		});
		expect(missingActor.ok).toBe(false);
		if (!missingActor.ok) expect(missingActor.field).toBe("actor");

		const wrongAdded = METHODS.chat_react.validateResult({
			messageId: 42,
			actor: "reviewer",
			emoji: "👀",
			added: "yes",
		});
		expect(wrongAdded.ok).toBe(false);
		if (!wrongAdded.ok) expect(wrongAdded.field).toBe("added");

		const wrongRemoved = METHODS.chat_unreact.validateResult({
			messageId: 42,
			actor: "reviewer",
			emoji: "👀",
			removed: "yes",
		});
		expect(wrongRemoved.ok).toBe(false);
		if (!wrongRemoved.ok) expect(wrongRemoved.field).toBe("removed");
	});

	test("steering results validate string lines and queued state", () => {
		const badLine = METHODS.logs_tail.validateResult({
			name: "researcher",
			lines: ["ok", 7],
		});
		expect(badLine.ok).toBe(false);
		if (!badLine.ok) expect(badLine.field).toBe("lines");

		const badQueued = METHODS.inject.validateResult({
			name: "researcher",
			queued: "yes",
		});
		expect(badQueued.ok).toBe(false);
		if (!badQueued.ok) expect(badQueued.field).toBe("queued");
	});

	test("optional RoomMessage metadata is additive and validated when present", () => {
		const legacy = {
			id: 1,
			room: "#a",
			author: "reviewer",
			body: "done",
			createdAt: 1,
		};
		expect(METHODS.chat_read.validateResult({ messages: [legacy] }).ok).toBe(
			true,
		);

		for (const [field, value] of [
			["parentId", "1"],
			["threadRootId", "1"],
			["replyCount", "0"],
			["reactions", [{ actor: "reviewer", emoji: 1 }]],
		] as const) {
			const result = METHODS.chat_wait.validateResult({
				messages: [{ ...legacy, [field]: value }],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toContain(field);
		}
	});

	test("agent_status accepts both legacy and hierarchical AgentStatus shapes", () => {
		const legacyShape = {
			agents: [{ name: "researcher", state: "running", account: "acct-1" }],
		};
		expect(METHODS.agent_status.validateResult(legacyShape).ok).toBe(true);

		const hierarchicalShape = {
			agents: [
				{
					name: "researcher",
					state: "running",
					account: "acct-1",
					parent: "orchestrator",
					children: ["intern-1", "intern-2"],
				},
			],
		};
		expect(METHODS.agent_status.validateResult(hierarchicalShape).ok).toBe(
			true,
		);

		const badParent = METHODS.agent_status.validateResult({
			agents: [{ ...legacyShape.agents[0], parent: 7 }],
		});
		expect(badParent.ok).toBe(false);
		if (!badParent.ok) expect(badParent.field).toContain("parent");

		const badChildren = METHODS.agent_status.validateResult({
			agents: [{ ...legacyShape.agents[0], children: ["ok", 7] }],
		});
		expect(badChildren.ok).toBe(false);
		if (!badChildren.ok) expect(badChildren.field).toContain("children");
	});

	test("agent_create result requires name and created, accepting true and false", () => {
		expect(
			METHODS.agent_create.validateResult({
				name: "researcher",
				created: true,
			}).ok,
		).toBe(true);
		expect(
			METHODS.agent_create.validateResult({
				name: "researcher",
				created: false,
			}).ok,
		).toBe(true);

		const missingCreated = METHODS.agent_create.validateResult({
			name: "researcher",
		});
		expect(missingCreated.ok).toBe(false);
		if (!missingCreated.ok) expect(missingCreated.field).toBe("created");

		const wrongCreated = METHODS.agent_create.validateResult({
			name: "researcher",
			created: "yes",
		});
		expect(wrongCreated.ok).toBe(false);
		if (!wrongCreated.ok) expect(wrongCreated.field).toBe("created");

		const missingName = METHODS.agent_create.validateResult({
			created: true,
		});
		expect(missingName.ok).toBe(false);
		if (!missingName.ok) expect(missingName.field).toBe("name");
	});

	test("definition_get result requires name, filePath, and a valid definition, naming nested fields", () => {
		expect(
			METHODS.definition_get.validateResult({
				name: "researcher",
				filePath: DEFINITION_FILE_PATH,
				definition: VALID_PEER_DEFINITION,
			}).ok,
		).toBe(true);

		const missingName = METHODS.definition_get.validateResult({
			filePath: DEFINITION_FILE_PATH,
			definition: VALID_PEER_DEFINITION,
		});
		expect(missingName.ok).toBe(false);
		if (!missingName.ok) expect(missingName.field).toBe("name");

		const missingDefinition = METHODS.definition_get.validateResult({
			name: "researcher",
			filePath: DEFINITION_FILE_PATH,
		});
		expect(missingDefinition.ok).toBe(false);
		if (!missingDefinition.ok)
			expect(missingDefinition.field).toBe("definition");

		const missingFilePath = METHODS.definition_get.validateResult({
			name: "researcher",
			definition: VALID_PEER_DEFINITION,
		});
		expect(missingFilePath.ok).toBe(false);
		if (!missingFilePath.ok) expect(missingFilePath.field).toBe("filePath");

		const badNestedField = METHODS.definition_get.validateResult({
			name: "researcher",
			filePath: DEFINITION_FILE_PATH,
			definition: { ...VALID_PEER_DEFINITION, sha256: 7 },
		});
		expect(badNestedField.ok).toBe(false);
		if (!badNestedField.ok) {
			expect(badNestedField.field).toBe("definition.sha256");
		}

		const badAutomation = METHODS.definition_get.validateResult({
			name: "researcher",
			filePath: DEFINITION_FILE_PATH,
			definition: {
				...VALID_PEER_DEFINITION,
				automations: [{ event: "on_mention", prompt: false }],
			},
		});
		expect(badAutomation.ok).toBe(false);
		if (!badAutomation.ok) {
			expect(badAutomation.field).toBe("definition.automations[0].prompt");
		}

		const systemField = METHODS.definition_get.validateResult({
			name: "researcher",
			filePath: DEFINITION_FILE_PATH,
			definition: { ...VALID_PEER_DEFINITION, systemPrompt: "not data" },
		});
		expect(systemField.ok).toBe(false);
		if (!systemField.ok)
			expect(systemField.field).toBe("definition.systemPrompt");
	});

	test("definition_update result requires name and rebuildRequired, naming malformed fields", () => {
		expect(
			METHODS.definition_update.validateResult({
				name: "researcher",
				rebuildRequired: true,
			}).ok,
		).toBe(true);
		expect(
			METHODS.definition_update.validateResult({
				name: "researcher",
				rebuildRequired: false,
			}).ok,
		).toBe(true);

		const missingName = METHODS.definition_update.validateResult({
			rebuildRequired: true,
		});
		expect(missingName.ok).toBe(false);
		if (!missingName.ok) expect(missingName.field).toBe("name");

		const missingRebuildRequired = METHODS.definition_update.validateResult({
			name: "researcher",
		});
		expect(missingRebuildRequired.ok).toBe(false);
		if (!missingRebuildRequired.ok)
			expect(missingRebuildRequired.field).toBe("rebuildRequired");

		const wrongRebuildRequired = METHODS.definition_update.validateResult({
			name: "researcher",
			rebuildRequired: "yes",
		});
		expect(wrongRebuildRequired.ok).toBe(false);
		if (!wrongRebuildRequired.ok)
			expect(wrongRebuildRequired.field).toBe("rebuildRequired");
	});

	test("daemon_stop result requires stopping true and a live pid", () => {
		expect(
			METHODS.daemon_stop.validateResult({ stopping: true, pid: 4242 }).ok,
		).toBe(true);

		// `stopping: false` is not a shape this method may answer: the ack is
		// the promise that shutdown is under way, so a daemon declining is an
		// error frame, never a success saying "no".
		const notStopping = METHODS.daemon_stop.validateResult({
			stopping: false,
			pid: 4242,
		});
		expect(notStopping.ok).toBe(false);
		if (!notStopping.ok) expect(notStopping.field).toBe("stopping");

		const missingPid = METHODS.daemon_stop.validateResult({ stopping: true });
		expect(missingPid.ok).toBe(false);
		if (!missingPid.ok) expect(missingPid.field).toBe("pid");

		for (const pid of [0, -1, 1.5]) {
			const result = METHODS.daemon_stop.validateResult({
				stopping: true,
				pid,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("pid");
		}
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
