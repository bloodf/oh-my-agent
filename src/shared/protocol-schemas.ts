/**
 * Purpose: Hand-rolled runtime validation for every control-socket method's
 *   params and result (T-507). Types vanish at runtime; the socket is where
 *   an unknown client reaches the daemon, so the boundary checks everything.
 *   This package carries no runtime dependencies and this module adds none.
 *
 * Public API: `Validation<T>`, the per-method `validate*Params` /
 * `validate*Result` functions, and the `METHODS` registry keyed by method
 * name.
 *
 * Upstream deps: `./protocol` (types only).
 *
 * Downstream consumers: the daemon socket server validates inbound params,
 * clients validate inbound results, and the contract suite pins both.
 *
 * Failure modes: validation never throws — a failure is
 * `{ ok: false, field, message }` with the offending leaf field named
 * (`messages[0].id`, not `messages`), which the server maps to an
 * `invalidParams` frame.
 *
 * Performance: O(payload size) per validation; no allocation on the happy
 * path beyond the result wrapper.
 */

import type {
	AgentCreateParams,
	AgentCreateResult,
	AgentSpawnParams,
	AgentSpawnResult,
	AgentStatus,
	AgentStatusParams,
	AgentStatusResult,
	BumpParams,
	BumpResult,
	ChatReactionParams,
	ChatReactResult,
	ChatReadParams,
	ChatReadResult,
	ChatSendParams,
	ChatSendResult,
	ChatUnreactResult,
	ChatWaitParams,
	ChatWaitResult,
	DefinitionData,
	DefinitionGetParams,
	DefinitionGetResult,
	DefinitionUpdateParams,
	DefinitionUpdateResult,
	InjectParams,
	InjectResult,
	KillParams,
	KillResult,
	LogsTailParams,
	LogsTailResult,
	MethodName,
	RoomMessage,
	RoomsListParams,
	RoomsListResult,
	RoomsPostParams,
	RoomsPostResult,
	SchedulesArmParams,
	SchedulesArmResult,
	SchedulesListParams,
	SchedulesListResult,
	StatusParams,
	StatusResult,
	TaskHandoffParams,
	TaskHandoffResult,
} from "./protocol";

export type Validation<T> =
	| { ok: true; value: T }
	| { ok: false; field: string; message: string };

function fail<T>(field: string, message: string): Validation<T> {
	return { ok: false, field, message };
}

function ok<T>(value: T): Validation<T> {
	return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// ── Leaf explainers ─────────────────────────────────────────────────────────
// Each returns the offending relative field, or null when the value is valid.
// Explainers (not boolean guards) so a failure deep in a list still names the
// leaf: `messages[0].id`, not `messages`.

function explainAgentState(value: unknown): string | null {
	return value === "running" || value === "parked" || value === "stopped"
		? null
		: "state";
}

function explainAgentStatus(value: unknown): string | null {
	if (!isRecord(value)) return "";
	if (!isNonEmptyString(value.name)) return "name";
	const state = explainAgentState(value.state);
	if (state !== null) return state;
	if (!isNonEmptyString(value.account)) return "account";
	if (value.model !== undefined && typeof value.model !== "string")
		return "model";
	if (value.sandboxed !== undefined && typeof value.sandboxed !== "boolean")
		return "sandboxed";
	if (value.parent !== undefined && typeof value.parent !== "string")
		return "parent";
	if (value.children !== undefined) {
		if (!Array.isArray(value.children)) return "children";
		const invalid = value.children.findIndex(
			(child) => typeof child !== "string",
		);
		if (invalid !== -1) return `children[${invalid}]`;
	}
	return null;
}

function explainRoomMessage(value: unknown): string | null {
	if (!isRecord(value)) return "";
	if (!isFiniteNumber(value.id)) return "id";
	if (!isNonEmptyString(value.room)) return "room";
	if (typeof value.author !== "string") return "author";
	if (typeof value.body !== "string") return "body";
	if (!isFiniteNumber(value.createdAt)) return "createdAt";
	if (
		value.parentId !== undefined &&
		value.parentId !== null &&
		!isFiniteNumber(value.parentId)
	)
		return "parentId";
	if (
		value.threadRootId !== undefined &&
		value.threadRootId !== null &&
		!isFiniteNumber(value.threadRootId)
	)
		return "threadRootId";
	if (value.replyCount !== undefined && !isFiniteNumber(value.replyCount))
		return "replyCount";
	if (value.reactions !== undefined) {
		if (!Array.isArray(value.reactions)) return "reactions";
		for (let i = 0; i < value.reactions.length; i++) {
			const reaction = value.reactions[i];
			if (!isRecord(reaction)) return `reactions[${i}]`;
			if (!isNonEmptyString(reaction.actor)) return `reactions[${i}].actor`;
			if (!isNonEmptyString(reaction.emoji)) return `reactions[${i}].emoji`;
		}
	}
	return null;
}

function explainRoomInfo(value: unknown): string | null {
	if (!isRecord(value)) return "";
	if (!isNonEmptyString(value.id)) return "id";
	if (value.kind !== "channel" && value.kind !== "dm") return "kind";
	if (!isNonEmptyString(value.name)) return "name";
	return null;
}

function explainScheduleInfo(value: unknown): string | null {
	if (!isRecord(value)) return "";
	if (!isNonEmptyString(value.id)) return "id";
	if (value.cron !== null && typeof value.cron !== "string") return "cron";
	if (!isNonEmptyString(value.action)) return "action";
	if (value.nextFireAt !== null && !isFiniteNumber(value.nextFireAt)) {
		return "nextFireAt";
	}
	if (typeof value.enabled !== "boolean") return "enabled";
	return null;
}

function explainStringArray(value: unknown): string | null {
	if (!Array.isArray(value)) return "";
	const invalid = value.findIndex((item) => typeof item !== "string");
	return invalid === -1 ? null : `[${invalid}]`;
}

function explainWake(value: unknown): string | null {
	if (!isRecord(value)) return "";
	for (const field of Object.keys(value)) {
		if (field !== "mention" && field !== "rooms") return field;
	}
	if (value.mention !== undefined && typeof value.mention !== "boolean")
		return "mention";
	if (value.rooms !== undefined && typeof value.rooms !== "boolean")
		return "rooms";
	return null;
}

function explainAutonomy(value: unknown): string | null {
	if (!isRecord(value)) return "";
	for (const field of Object.keys(value)) {
		if (field !== "maxTurns" && field !== "budgetUsd") return field;
	}
	if (
		value.maxTurns !== undefined &&
		(typeof value.maxTurns !== "number" ||
			!Number.isSafeInteger(value.maxTurns) ||
			value.maxTurns <= 0)
	)
		return "maxTurns";
	if (
		value.budgetUsd !== undefined &&
		(!isFiniteNumber(value.budgetUsd) || value.budgetUsd <= 0)
	)
		return "budgetUsd";
	return null;
}

function explainSandbox(value: unknown): string | null {
	if (typeof value === "boolean") return null;
	if (!isRecord(value)) return "";
	for (const field of Object.keys(value)) {
		if (field !== "enabled" && field !== "extraRoots") return field;
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean")
		return "enabled";
	if (value.extraRoots !== undefined) {
		const leaf = explainStringArray(value.extraRoots);
		if (leaf !== null) return leaf === "" ? "extraRoots" : `extraRoots${leaf}`;
	}
	return null;
}

function explainSchedule(value: unknown): string | null {
	if (!isRecord(value)) return "";
	for (const field of Object.keys(value)) {
		if (field !== "cron" && field !== "prompt" && field !== "room")
			return field;
	}
	if (!isNonEmptyString(value.cron)) return "cron";
	if (!isNonEmptyString(value.prompt)) return "prompt";
	if (value.room !== undefined && typeof value.room !== "string") return "room";
	return null;
}

function explainAutomation(value: unknown): string | null {
	if (!isRecord(value)) return "";
	for (const field of Object.keys(value)) {
		if (field !== "event" && field !== "prompt" && field !== "room")
			return field;
	}
	if (!isNonEmptyString(value.event)) return "event";
	if (!isNonEmptyString(value.prompt)) return "prompt";
	if (value.room !== undefined && typeof value.room !== "string") return "room";
	return null;
}

function nestedLeaf(
	record: Record<string, unknown>,
	field: string,
	explain: (value: unknown) => string | null,
	required = false,
): string | null {
	const value = record[field];
	if (value === undefined) return required ? field : null;
	const leaf = explain(value);
	if (leaf === null) return null;
	return leaf === ""
		? field
		: `${field}${leaf.startsWith("[") ? "" : "."}${leaf}`;
}

const DEFINITION_FIELDS: Record<string, boolean> = {
	name: true,
	description: true,
	model: true,
	tools: true,
	spawns: true,
	thinkingLevel: true,
	output: true,
	blocking: true,
	autoloadSkills: true,
	readSummarize: true,
	prewalk: true,
	advisor: true,
	body: true,
	workspace: true,
	rooms: true,
	wake: true,
	autonomy: true,
	sandbox: true,
	mcps: true,
	skills: true,
	schedules: true,
	automations: true,
	sha256: true,
};

const CREATE_FIELDS: Record<string, boolean> = {
	name: true,
	description: true,
	model: true,
	rooms: true,
	wake: true,
	autonomy: true,
	spawns: true,
	body: true,
};

const CHANGE_FIELDS: Record<string, boolean> = {
	...DEFINITION_FIELDS,
	name: false,
	sha256: false,
};

function explainDefinitionFields(
	value: unknown,
	required: "definition" | "create" | "changes",
): string | null {
	if (!isRecord(value)) return "";
	const requireDefinition = required === "definition";
	const allowed =
		required === "definition"
			? DEFINITION_FIELDS
			: required === "create"
				? CREATE_FIELDS
				: CHANGE_FIELDS;
	for (const field of Object.keys(value)) {
		if (allowed[field] !== true) return field;
	}
	const requireCreate = required === "create";
	for (const field of ["name", "description", "body"] as const) {
		if ((requireDefinition || requireCreate) && !isNonEmptyString(value[field]))
			return field;
		if (value[field] !== undefined && !isNonEmptyString(value[field]))
			return field;
	}
	if (value.description !== undefined && typeof value.description !== "string")
		return "description";
	if (requireDefinition && !isNonEmptyString(value.sha256)) return "sha256";
	if (value.sha256 !== undefined && !isNonEmptyString(value.sha256))
		return "sha256";

	for (const field of [
		"model",
		"tools",
		"autoloadSkills",
		"rooms",
		"mcps",
		"skills",
	] as const) {
		const leaf = nestedLeaf(value, field, explainStringArray);
		if (leaf !== null) return leaf;
	}
	if (value.spawns === undefined) {
		if (requireDefinition) return "spawns";
	} else if (value.spawns !== "*") {
		const leaf = explainStringArray(value.spawns);
		if (leaf !== null) return leaf === "" ? "spawns" : `spawns${leaf}`;
	}
	if (
		value.thinkingLevel !== undefined &&
		![
			"inherit",
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"auto",
		].includes(value.thinkingLevel as string)
	)
		return "thinkingLevel";
	for (const field of ["blocking", "readSummarize"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "boolean")
			return field;
	}
	for (const field of ["prewalk", "advisor"] as const) {
		if (
			value[field] !== undefined &&
			typeof value[field] !== "boolean" &&
			typeof value[field] !== "string"
		)
			return field;
	}
	if (value.workspace !== undefined && typeof value.workspace !== "string")
		return "workspace";
	for (const [field, explain] of [
		["wake", explainWake],
		["autonomy", explainAutonomy],
		["sandbox", explainSandbox],
	] as const) {
		const leaf = nestedLeaf(value, field, explain);
		if (leaf !== null) return leaf;
	}
	for (const [field, explain] of [
		["schedules", explainSchedule],
		["automations", explainAutomation],
	] as const) {
		const list = value[field];
		if (list === undefined) continue;
		if (!Array.isArray(list)) return field;
		for (let i = 0; i < list.length; i++) {
			const leaf = explain(list[i]);
			if (leaf !== null)
				return leaf === "" ? `${field}[${i}]` : `${field}[${i}].${leaf}`;
		}
	}
	return null;
}

function checkList(
	value: unknown,
	field: string,
	explain: (item: unknown) => string | null,
): Validation<unknown[]> {
	if (!Array.isArray(value)) return fail(field, `${field} must be an array`);
	for (let i = 0; i < value.length; i++) {
		const leaf = explain(value[i]);
		if (leaf !== null) {
			const at = leaf === "" ? `${field}[${i}]` : `${field}[${i}].${leaf}`;
			return fail(at, `${at} is malformed`);
		}
	}
	return ok(value);
}

// ── Shared field helpers ────────────────────────────────────────────────────

type FieldCheck = { field: string; message: string } | null;

function requireString(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return isNonEmptyString(record[field])
		? null
		: { field, message: `${field} must be a non-empty string` };
}

function requireNumber(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return isFiniteNumber(record[field])
		? null
		: { field, message: `${field} must be a finite number` };
}

function requirePositiveSafeInteger(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	const value = record[field];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? null
		: { field, message: `${field} must be a positive safe integer` };
}

function requireBoolean(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return typeof record[field] === "boolean"
		? null
		: { field, message: `${field} must be a boolean` };
}

function optionalString(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return record[field] === undefined || typeof record[field] === "string"
		? null
		: { field, message: `${field} must be a string when present` };
}

function optionalNonEmptyString(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return record[field] === undefined || isNonEmptyString(record[field])
		? null
		: { field, message: `${field} must be a non-empty string when present` };
}

function optionalNumber(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return record[field] === undefined || isFiniteNumber(record[field])
		? null
		: { field, message: `${field} must be a finite number when present` };
}

function optionalStringArray(
	record: Record<string, unknown>,
	field: string,
): FieldCheck {
	return record[field] === undefined || isStringArray(record[field])
		? null
		: { field, message: `${field} must be a string array when present` };
}

function checkFields(
	value: unknown,
	checks: Array<(record: Record<string, unknown>) => FieldCheck>,
): FieldCheck {
	if (!isRecord(value))
		return { field: "params", message: "expected an object" };
	for (const check of checks) {
		const failure = check(value);
		if (failure) return failure;
	}
	return null;
}

function fromFields<T>(value: unknown, failure: FieldCheck): Validation<T> {
	return failure ? fail(failure.field, failure.message) : ok(value as T);
}

function validateNoParams(value: unknown): Validation<Record<string, never>> {
	if (!isRecord(value)) return fail("params", "expected an object");
	const keys = Object.keys(value);
	if (keys.length > 0)
		return fail("params", `unexpected parameter: ${keys[0]}`);
	return ok(value as Record<string, never>);
}

// ── Method validators ───────────────────────────────────────────────────────

function validateChatSendShape(value: unknown): Validation<ChatSendParams> {
	return fromFields(
		value,
		checkFields(value, [
			(r) => requireString(r, "room"),
			(r) => requireString(r, "body"),
			(r) => optionalString(r, "author"),
		]),
	);
}

function validateChatSendResultShape(
	value: unknown,
): Validation<ChatSendResult> {
	return fromFields(
		value,
		checkFields(value, [
			(r) => requireNumber(r, "messageId"),
			(r) => requireNumber(r, "createdAt"),
		]),
	);
}

function validateMessagesResult(
	value: unknown,
): Validation<{ messages: RoomMessage[] }> {
	if (!isRecord(value)) return fail("result", "expected an object");
	const messages = checkList(value.messages, "messages", explainRoomMessage);
	if (!messages.ok) return fail(messages.field, messages.message);
	return ok(value as { messages: RoomMessage[] });
}

function validateReactionParams(
	value: unknown,
): Validation<ChatReactionParams> {
	return fromFields(
		value,
		checkFields(value, [
			(r) => requirePositiveSafeInteger(r, "messageId"),
			(r) => requireString(r, "actor"),
			(r) => requireString(r, "emoji"),
		]),
	);
}

function validateReactionResult<T>(
	value: unknown,
	outcome: "added" | "removed",
): Validation<T> {
	return fromFields(
		value,
		checkFields(value, [
			(r) => requireNumber(r, "messageId"),
			(r) => requireString(r, "actor"),
			(r) => requireString(r, "emoji"),
			(r) => requireBoolean(r, outcome),
		]),
	);
}

function validateAgentsResult(
	value: unknown,
): Validation<{ agents: AgentStatus[] }> {
	if (!isRecord(value)) return fail("result", "expected an object");
	const agents = checkList(value.agents, "agents", explainAgentStatus);
	if (!agents.ok) return fail(agents.field, agents.message);
	return ok(value as { agents: AgentStatus[] });
}

function validateDefinitionShape<T>(
	value: unknown,
	prefix: string,
	kind: "definition" | "create" | "changes",
): Validation<T> {
	const leaf = explainDefinitionFields(value, kind);
	if (leaf !== null) {
		const field = leaf === "" ? prefix : prefix ? `${prefix}.${leaf}` : leaf;
		return fail(field, `${field} is malformed`);
	}
	return ok(value as T);
}

function validateNamedBooleanResult<T>(
	value: unknown,
	field: string,
): Validation<T> {
	return fromFields(
		value,
		checkFields(value, [
			(r) => requireString(r, "name"),
			(r) => requireBoolean(r, field),
		]),
	);
}

// ── Registry ────────────────────────────────────────────────────────────────

interface MethodContract {
	validateParams: (value: unknown) => Validation<unknown>;
	validateResult: (value: unknown) => Validation<unknown>;
}

export const METHODS: Record<MethodName, MethodContract> = {
	status: {
		validateParams: (v): Validation<StatusParams> => validateNoParams(v),
		validateResult: (v): Validation<StatusResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			const base = checkFields(v, [
				(r) => requireNumber(r, "protocolVersion"),
				(r) => requireNumber(r, "uptimeMs"),
			]);
			if (base) return fail(base.field, base.message);
			const agents = checkList(v.agents, "agents", explainAgentStatus);
			if (!agents.ok) return fail(agents.field, agents.message);
			return ok(v as unknown as StatusResult);
		},
	},
	chat_send: {
		validateParams: validateChatSendShape,
		validateResult: validateChatSendResultShape,
	},
	chat_read: {
		validateParams: (v): Validation<ChatReadParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "room"),
					(r) => optionalNumber(r, "sinceId"),
					(r) => optionalNumber(r, "limit"),
				]),
			),
		validateResult: (v): Validation<ChatReadResult> =>
			validateMessagesResult(v),
	},
	chat_wait: {
		validateParams: (v): Validation<ChatWaitParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => optionalString(r, "room"),
					(r) => optionalNumber(r, "sinceId"),
					(r) => optionalNumber(r, "timeoutMs"),
				]),
			),
		validateResult: (v): Validation<ChatWaitResult> =>
			validateMessagesResult(v),
	},
	chat_react: {
		validateParams: validateReactionParams,
		validateResult: (v): Validation<ChatReactResult> =>
			validateReactionResult(v, "added"),
	},
	chat_unreact: {
		validateParams: validateReactionParams,
		validateResult: (v): Validation<ChatUnreactResult> =>
			validateReactionResult(v, "removed"),
	},
	agent_spawn: {
		validateParams: (v): Validation<AgentSpawnParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "name"),
					(r) => optionalStringArray(r, "rooms"),
					(r) => optionalString(r, "cwd"),
					(r) => optionalNonEmptyString(r, "parent"),
				]),
			),
		validateResult: (v): Validation<AgentSpawnResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			if (!isNonEmptyString(v.name)) {
				return fail("name", "name must be a non-empty string");
			}
			const state = explainAgentState(v.state);
			if (state !== null)
				return fail(state, "state must be running, parked, or stopped");
			return ok(v as unknown as AgentSpawnResult);
		},
	},
	agent_create: {
		validateParams: (v): Validation<AgentCreateParams> =>
			isRecord(v)
				? validateDefinitionShape(v, "", "create")
				: fail("params", "expected an object"),
		validateResult: (v): Validation<AgentCreateResult> =>
			validateNamedBooleanResult(v, "created"),
	},
	definition_get: {
		validateParams: (v): Validation<DefinitionGetParams> =>
			fromFields(v, checkFields(v, [(r) => requireString(r, "name")])),
		validateResult: (v): Validation<DefinitionGetResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			const base = checkFields(v, [
				(r) => requireString(r, "name"),
				(r) => requireString(r, "filePath"),
			]);
			if (base) return fail(base.field, base.message);
			const definition = validateDefinitionShape<DefinitionData>(
				v.definition,
				"definition",
				"definition",
			);
			return definition.ok
				? ok(v as unknown as DefinitionGetResult)
				: definition;
		},
	},
	definition_update: {
		validateParams: (v): Validation<DefinitionUpdateParams> => {
			if (!isRecord(v)) return fail("params", "expected an object");
			const name = requireString(v, "name");
			if (name) return fail(name.field, name.message);
			return validateDefinitionShape(v.changes, "changes", "changes");
		},
		validateResult: (v): Validation<DefinitionUpdateResult> =>
			validateNamedBooleanResult(v, "rebuildRequired"),
	},
	agent_status: {
		validateParams: (v): Validation<AgentStatusParams> =>
			fromFields(v, checkFields(v, [(r) => optionalString(r, "name")])),
		validateResult: (v): Validation<AgentStatusResult> =>
			validateAgentsResult(v),
	},
	logs_tail: {
		validateParams: (v): Validation<LogsTailParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "name"),
					(r) =>
						r.lines === undefined
							? null
							: requirePositiveSafeInteger(r, "lines"),
				]),
			),
		validateResult: (v): Validation<LogsTailResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			const name = requireString(v, "name");
			if (name) return fail(name.field, name.message);
			if (!isStringArray(v.lines)) {
				return fail("lines", "lines must be a string array");
			}
			return ok(v as unknown as LogsTailResult);
		},
	},
	inject: {
		validateParams: (v): Validation<InjectParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "name"),
					(r) => requireString(r, "message"),
				]),
			),
		validateResult: (v): Validation<InjectResult> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "name"),
					(r) => requireBoolean(r, "queued"),
				]),
			),
	},
	task_handoff: {
		validateParams: (v): Validation<TaskHandoffParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "fromAgent"),
					(r) => requireString(r, "toAgent"),
					(r) => requireString(r, "summary"),
					(r) => optionalStringArray(r, "artifacts"),
				]),
			),
		validateResult: (v): Validation<TaskHandoffResult> =>
			fromFields(v, checkFields(v, [(r) => requireString(r, "handoffId")])),
	},
	rooms_list: {
		validateParams: (v): Validation<RoomsListParams> => validateNoParams(v),
		validateResult: (v): Validation<RoomsListResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			const rooms = checkList(v.rooms, "rooms", explainRoomInfo);
			if (!rooms.ok) return fail(rooms.field, rooms.message);
			return ok(v as unknown as RoomsListResult);
		},
	},
	rooms_post: {
		validateParams: (v): Validation<RoomsPostParams> =>
			validateChatSendShape(v),
		validateResult: (v): Validation<RoomsPostResult> =>
			validateChatSendResultShape(v),
	},
	schedules_list: {
		validateParams: (v): Validation<SchedulesListParams> => validateNoParams(v),
		validateResult: (v): Validation<SchedulesListResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			const schedules = checkList(
				v.schedules,
				"schedules",
				explainScheduleInfo,
			);
			if (!schedules.ok) return fail(schedules.field, schedules.message);
			return ok(v as unknown as SchedulesListResult);
		},
	},
	schedules_arm: {
		validateParams: (v): Validation<SchedulesArmParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "scheduleId"),
					(r) => requireBoolean(r, "enabled"),
				]),
			),
		validateResult: (v): Validation<SchedulesArmResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			if (!("schedule" in v)) return fail("schedule", "schedule is required");
			const leaf = explainScheduleInfo(v.schedule);
			if (leaf !== null) {
				const at = leaf === "" ? "schedule" : `schedule.${leaf}`;
				return fail(at, `${at} is malformed`);
			}
			return ok(v as unknown as SchedulesArmResult);
		},
	},
	kill: {
		validateParams: (v): Validation<KillParams> =>
			fromFields(v, checkFields(v, [(r) => requireString(r, "name")])),
		validateResult: (v): Validation<KillResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			if (!isNonEmptyString(v.name)) {
				return fail("name", "name must be a non-empty string");
			}
			if (v.state !== "stopped") return fail("state", "state must be stopped");
			return ok(v as unknown as KillResult);
		},
	},
	bump: {
		validateParams: (v): Validation<BumpParams> =>
			fromFields(
				v,
				checkFields(v, [
					(r) => requireString(r, "account"),
					(r) => requireNumber(r, "budgetUsd"),
				]),
			),
		validateResult: (v): Validation<BumpResult> => {
			if (!isRecord(v)) return fail("result", "expected an object");
			const base = checkFields(v, [
				(r) => requireString(r, "account"),
				(r) => requireNumber(r, "budgetUsd"),
			]);
			if (base) return fail(base.field, base.message);
			if (!isStringArray(v.resumed)) {
				return fail("resumed", "resumed must be a string array");
			}
			return ok(v as unknown as BumpResult);
		},
	},
};
