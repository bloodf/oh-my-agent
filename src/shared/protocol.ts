/**
 * Purpose: The daemon control-socket contract as one typed, versioned,
 *   transport-free artifact. The daemon server (T-502), the worker toolbelt
 *   (T-503), and every operator client (T-504, web console) share this module,
 *   so the wire shape can never fork into three private dialects.
 *
 * Public API: `PROTOCOL_VERSION`, `METHOD_NAMES`, per-method params/result
 * types, the JSON-RPC envelope types, `ERROR_CODE`, and the `methodNotFound`,
 * `invalidParams`, `unauthorized`, and `forbidden` error builders. Runtime
 * validation lives in `./protocol-schemas`.
 *
 * Upstream deps: `./agent-definition` (type only, for the parsed definition
 * data shape). This module stays free of transport, I/O, and daemon state.
 *
 * Downstream consumers: the daemon socket server, the worker toolbelt, the
 * TUI extension, and the web console API.
 *
 * Failure modes: protocol errors are data, not exceptions. Error builders
 * always carry `data.protocolVersion`, so a mismatched client learns why.
 * Authentication and authorization failures use distinct declared codes. New
 * methods are additive and do not bump `PROTOCOL_VERSION`: old daemons already
 * answer an unknown method with their version, which is the mismatch path.
 *
 * Performance: type declarations only; zero runtime cost beyond the small
 * error builders.
 */
import type { PeerDefinition } from "./agent-definition";

export const PROTOCOL_VERSION = 1 as const;

export const METHOD_NAMES = [
	"status",
	"chat_send",
	"chat_read",
	"chat_wait",
	"chat_react",
	"chat_unreact",
	"agent_spawn",
	"agent_create",
	"definition_get",
	"definition_update",
	"agent_status",
	"logs_tail",
	"inject",
	"task_handoff",
	"rooms_list",
	"room_create",
	"room_join",
	"room_leave",
	"rooms_post",
	"room_plans_list",
	"room_plan_create",
	"room_plan_update",
	"schedules_list",
	"schedules_arm",
	"models_list",
	"presets_list",
	"kill",
	"bump",
	"daemon_stop",
] as const;

export type MethodName = (typeof METHOD_NAMES)[number];

// ── Shared shapes ───────────────────────────────────────────────────────────

export type AgentState = "running" | "parked" | "stopped";

export interface AgentStatus {
	name: string;
	state: AgentState;
	account: string;
	model?: string;
	sandboxed?: boolean;
	/** Live worker's OS pid; absent when parked, stopped, or a stub. */
	pid?: number;
	parent?: string;
	children?: string[];
	/**
	 * Why this peer is not running, when a start attempt failed.
	 *
	 * A boot-time start failure used to exist only as a line in the daemon's
	 * own log: the operator saw a peer that was simply absent from `status`
	 * with no way to ask why from any surface. Cleared by the next successful
	 * start.
	 */
	lastError?: string;
}

export interface RoomMessage {
	id: number;
	room: string;
	author: string;
	body: string;
	createdAt: number;
	mentions?: string[];
	parentId?: number | null;
	threadRootId?: number | null;
	replyCount?: number;
	reactions?: Array<{ actor: string; emoji: string }>;
}

export interface RoomInfo {
	id: string;
	kind: "channel" | "dm";
	name: string;
	/** Canonical absolute directory inherited by agents without an explicit workspace. */
	workspace?: string;
}

export type PlanStatus = "draft" | "active" | "completed";

export interface RoomPlan {
	id: string;
	room: string;
	title: string;
	body: string;
	status: PlanStatus;
	revision: number;
	author: string;
	updatedBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface ScheduleInfo {
	id: string;
	cron: string | null;
	action: string;
	nextFireAt: number | null;
	enabled: boolean;
}

// ── Method payloads ─────────────────────────────────────────────────────────

export type StatusParams = Record<string, never>;
export interface StatusResult {
	protocolVersion: number;
	agents: AgentStatus[];
	uptimeMs: number;
	/**
	 * The daemon's own package version.
	 *
	 * A long-lived daemon outlives plugin upgrades — the operator's install
	 * ran 1.2.0 for four days against a 1.2.1 plugin tree — and nothing on the
	 * wire said so. Optional because a daemon older than this field is exactly
	 * the case a client needs to survive.
	 */
	version?: string;
}

export interface ChatSendParams {
	room: string;
	body: string;
	author?: string;
}
export interface ChatSendResult {
	messageId: number;
	createdAt: number;
}

export interface ChatReadParams {
	room: string;
	sinceId?: number;
	limit?: number;
}
export interface ChatReadResult {
	messages: RoomMessage[];
}

export interface ChatWaitParams {
	room?: string;
	sinceId?: number;
	timeoutMs?: number;
}
export interface ChatWaitResult {
	messages: RoomMessage[];
	/**
	 * The highest message id this wait considered, whether or not anything
	 * arrived.
	 *
	 * A caller keeping its own read cursor cannot derive this from `messages`:
	 * a wait that returns nothing tells it neither where "now" was nor where to
	 * resume, so its next call asks for "after now" again and it never advances
	 * past an idle moment. Optional because a daemon older than this field
	 * simply does not send it.
	 */
	latestId?: number;
}

export interface ChatReactionParams {
	messageId: number;
	actor: string;
	emoji: string;
}
export interface ChatReactResult extends ChatReactionParams {
	added: boolean;
}
export interface ChatUnreactResult extends ChatReactionParams {
	removed: boolean;
}

export interface AgentSpawnParams {
	name: string;
	rooms?: string[];
	cwd?: string;
	parent?: string;
}
export interface AgentSpawnResult {
	name: string;
	state: AgentState;
}

export interface AgentStatusParams {
	name?: string;
}
export interface AgentStatusResult {
	agents: AgentStatus[];
}

export type DefinitionData = Omit<PeerDefinition, "filePath">;

export type AgentCreateParams = Pick<
	DefinitionData,
	"name" | "description" | "body"
> &
	Partial<Omit<DefinitionData, "name" | "description" | "body" | "sha256">>;
export interface AgentCreateResult {
	name: string;
	created: boolean;
}

export interface DefinitionGetParams {
	name: string;
}
export interface DefinitionGetResult {
	name: string;
	definition: DefinitionData;
	filePath: string;
}

export interface DefinitionUpdateParams {
	name: string;
	changes: Partial<Omit<DefinitionData, "name" | "sha256">>;
}
export interface DefinitionUpdateResult {
	name: string;
	rebuildRequired: boolean;
}

/**
 * Which stderr stream a tail reads.
 *
 * Additive and optional: an omitted `source` is `"worker"`, which is what
 * every client predating daemon logs already sends and means.
 */
export type LogsSource = "worker" | "daemon";

export interface LogsTailParams {
	name: string;
	lines?: number;
	source?: LogsSource;
}
export interface LogsTailResult {
	name: string;
	lines: string[];
}

export interface InjectParams {
	name: string;
	message: string;
}
export interface InjectResult {
	name: string;
	queued: boolean;
}

export interface TaskHandoffParams {
	fromAgent: string;
	toAgent: string;
	summary: string;
	artifacts?: string[];
}
export interface TaskHandoffResult {
	handoffId: string;
}

export type RoomsListParams = Record<string, never>;
export interface RoomsListResult {
	rooms: RoomInfo[];
}

export interface RoomCreateParams {
	room: string;
}
export interface RoomCreateResult {
	room: RoomInfo;
	/** False when the room already existed. */
	created: boolean;
}
export interface RoomJoinParams {
	room: string;
	agent: string;
}
export interface RoomJoinResult {
	agent: string;
	room: string;
	/** The peer's membership after the change, as written to its definition. */
	rooms: string[];
	/** Whether the peer was registered, so the change took effect at once. */
	live: boolean;
	/** Whether the room's backlog was delivered to the peer as a turn. */
	delivered: boolean;
}
export type RoomLeaveParams = RoomJoinParams;
export type RoomLeaveResult = Omit<RoomJoinResult, "delivered">;
export type RoomsPostParams = ChatSendParams;
export type RoomsPostResult = ChatSendResult;

export interface RoomPlansListParams {
	room: string;
}
export interface RoomPlansListResult {
	plans: RoomPlan[];
}

export interface RoomPlanCreateParams {
	room: string;
	title: string;
	body: string;
}
export interface RoomPlanCreateResult {
	plan: RoomPlan;
}

export interface RoomPlanUpdateParams {
	room: string;
	id: string;
	title?: string;
	body?: string;
	status?: PlanStatus;
	expectedRevision: number;
}
export interface RoomPlanUpdateResult {
	plan: RoomPlan;
}

export type SchedulesListParams = Record<string, never>;

/** One model a peer can be pointed at, as `provider/id`. */
export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
}
/**
 * A shipped preset: a role definition the package carries but never seeds.
 * The fields are exactly what `agent_create` accepts, so a client copies
 * them under a name of its choosing and sends them as they are.
 */
export type PresetInfo = Pick<
	DefinitionData,
	"name" | "description" | "body" | "spawns"
> &
	Partial<Pick<DefinitionData, "rooms" | "wake" | "autonomy" | "model">>;
export type PresetsListParams = Record<string, never>;
export interface PresetsListResult {
	/** Every shipped preset, sorted by name. */
	presets: PresetInfo[];
}
export type ModelsListParams = Record<string, never>;
export interface ModelsListResult {
	/** Every model the daemon's credentials can route to, sorted by selector. */
	models: ModelChoice[];
	/** The `provider/id` a peer with no `model:` runs on, when OMP has one. */
	default?: string;
	/**
	 * Whether `default` appears in `models`. OMP's default may come from a
	 * TUI extension the daemon's gateway cannot route to; a peer left on it
	 * fails to start, and a picker that marked it as the default without
	 * saying so would be sending the operator to that failure.
	 */
	defaultRoutable?: boolean;
}
export interface SchedulesListResult {
	schedules: ScheduleInfo[];
}

export interface SchedulesArmParams {
	scheduleId: string;
	enabled: boolean;
}
export interface SchedulesArmResult {
	schedule: ScheduleInfo;
}

export interface KillParams {
	name: string;
}
export interface KillResult {
	name: string;
	state: "stopped";
}

export interface BumpParams {
	account: string;
	budgetUsd: number;
}
export interface BumpResult {
	account: string;
	budgetUsd: number;
	resumed: string[];
}

/**
 * Stop this daemon. No params: the pidfile names the only process it may take
 * down, so there is nothing left for a caller to select.
 */
export type DaemonStopParams = Record<string, never>;
export interface DaemonStopResult {
	/**
	 * Always `true`. This is an acknowledgement, not a question — a daemon that
	 * will not stop answers an error frame, so there is no `false` to carry.
	 */
	stopping: true;
	/** The process the caller may now watch for exit. */
	pid: number;
}

// ── JSON-RPC envelope ───────────────────────────────────────────────────────

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: MethodName;
	params?: unknown;
}

export interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: ProtocolError;
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure;

// ── Errors ──────────────────────────────────────────────────────────────────

export const ERROR_CODE = {
	PARSE_ERROR: -32700,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	UNAUTHORIZED: -32001,
	// Refusing on a documented, deliberate limit — not a malfunction. Distinct
	// from INTERNAL_ERROR so a client can tell "saturated, retry when a slot
	// frees" from "a handler threw" without matching on the message string.
	UNAVAILABLE: -32002,
	FORBIDDEN: -32003,
} as const;

export interface ProtocolError {
	code: number;
	message: string;
	data: {
		protocolVersion: number;
		field?: string;
	};
}

export function methodNotFound(id: JsonRpcId, method: string): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: ERROR_CODE.METHOD_NOT_FOUND,
			message: `Method not found: ${method}`,
			data: { protocolVersion: PROTOCOL_VERSION },
		},
	};
}

export function invalidParams(
	id: JsonRpcId,
	field: string,
	message: string,
): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: ERROR_CODE.INVALID_PARAMS,
			message,
			data: { protocolVersion: PROTOCOL_VERSION, field },
		},
	};
}

export function unauthorized(id: JsonRpcId): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: ERROR_CODE.UNAUTHORIZED,
			message: "Unauthorized",
			data: { protocolVersion: PROTOCOL_VERSION },
		},
	};
}

export function forbidden(id: JsonRpcId, message: string): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: ERROR_CODE.FORBIDDEN,
			message,
			data: { protocolVersion: PROTOCOL_VERSION },
		},
	};
}
