/**
 * Purpose: The daemon control-socket contract as one typed, versioned,
 *   transport-free artifact. The daemon server (T-502), the worker toolbelt
 *   (T-503), and every operator client (T-504, web console) share this module,
 *   so the wire shape can never fork into three private dialects.
 *
 * Public API: `PROTOCOL_VERSION`, `METHOD_NAMES`, per-method params/result
 * types, the JSON-RPC envelope types, `ERROR_CODE`, and the `methodNotFound`
 * / `invalidParams` error builders. Runtime validation lives in
 * `./protocol-schemas`.
 *
 * Upstream deps: none. This module must stay free of transport, I/O, and
 * daemon state — the contract suite asserts that statically.
 *
 * Downstream consumers: the daemon socket server, the worker toolbelt, the
 * TUI extension, and the web console API.
 *
 * Failure modes: protocol errors are data, not exceptions — `methodNotFound`
 * and `invalidParams` build JSON-RPC failure frames that always carry
 * `data.protocolVersion`, so a mismatched client learns why.
 *
 * Performance: type declarations only; zero runtime cost beyond the small
 * error builders.
 */

export const PROTOCOL_VERSION = 1 as const;

export const METHOD_NAMES = [
	"status",
	"chat_send",
	"chat_read",
	"chat_wait",
	"chat_react",
	"chat_unreact",
	"agent_spawn",
	"agent_status",
	"task_handoff",
	"rooms_list",
	"rooms_post",
	"schedules_list",
	"schedules_arm",
	"kill",
	"bump",
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
}

export interface RoomMessage {
	id: number;
	room: string;
	author: string;
	body: string;
	createdAt: number;
	parentId?: number | null;
	threadRootId?: number | null;
	replyCount?: number;
	reactions?: Array<{ actor: string; emoji: string }>;
}

export interface RoomInfo {
	id: string;
	kind: "channel" | "dm";
	name: string;
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

export type RoomsPostParams = ChatSendParams;
export type RoomsPostResult = ChatSendResult;

export type SchedulesListParams = Record<string, never>;
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
