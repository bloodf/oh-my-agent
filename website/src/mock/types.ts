/**
 * Shapes the mocked daemon keeps. Wire types come from the real console and
 * daemon sources so a drift there breaks the website typecheck, not the demo.
 */
// Relative, not the `@` alias, so the root test suite can typecheck these shapes too.
import type { AgentInfo, MessageReaction, RoomInfo, RoomMessage } from "../../../web/src/lib/types";
import type { AgentState } from "../../../src/shared/protocol";
import type {
	WebChatContentBlock,
	WebChatInfo,
	WebChatMessage,
	WebChatModel,
	WebChatState,
} from "../../../src/shared/web-workspace";

export type { AgentInfo, MessageReaction, RoomInfo, RoomMessage, WebChatContentBlock, WebChatInfo, WebChatMessage, WebChatModel, WebChatState };

export type PlanStatus = "draft" | "active" | "completed";

export type RoomPlan = {
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
};

/** A message as stored; thread counts are derived on read. */
export type StoredMessage = Omit<RoomMessage, "replyCount" | "threadRootId">;

export type ScheduleDefinition = { cron: string; prompt: string; room?: string };

export type AgentDefinition = {
	name: string;
	description: string;
	body: string;
	spawns?: string[] | "*";
	model?: string[];
	rooms?: string[];
	workspace?: string;
	wake?: { rooms?: boolean; mention?: boolean };
	autonomy?: { maxTurns?: number; budgetUsd?: number };
	schedules?: ScheduleDefinition[];
	heartbeat?: string;
	thinkingLevel?: string;
	tools?: string[];
	skills?: string[];
	[key: string]: unknown;
};

export type AgentRecord = {
	name: string;
	state: "running" | "parked" | "stopped";
	account: string;
	parent?: string;
	/** Present once the agent has a live worker; stopped definitions list rooms from the definition. */
	definition: AgentDefinition;
	logs: string[];
};

export type ScheduleRow = {
	id: string;
	agent: string;
	cron: string | null;
	action: string;
	nextFireAt: number | null;
	enabled: boolean;
};

export type ArtifactRow = {
	file: string;
	url: string;
	status: string;
	pendingPrompts: number;
	updatedAt: string;
};

export type Persona = { displayName?: string; avatar?: string };
export type Profile = { operator: Persona; agents: Record<string, Persona> };

export type ManagedAttachment = { id: string; name: string; type: string; size: number; path: string };

export type ChatRecord = {
	info: WebChatInfo;
	state: WebChatState;
	messages: WebChatMessage[];
	models: WebChatModel[];
};

export type WorkspaceFile = {
	path: string;
	originalPath?: string;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
};

export type RepoFixture = {
	root: string;
	branch: string;
	files: WorkspaceFile[];
	/** Diffs keyed by `${staged ? "staged" : "working"}:${path}`. */
	diffs: Record<string, string>;
};

export type ModelChoice = { provider: string; id: string; name: string };

export type Preset = {
	name: string;
	description: string;
	body: string;
	spawns: string[] | "*";
	rooms?: string[];
	model?: string | string[];
};

export type DemoState = {
	version: number;
	seededAt: number;
	nextMessageId: number;
	channels: RoomInfo[];
	messages: StoredMessage[];
	agents: AgentRecord[];
	plans: RoomPlan[];
	schedules: ScheduleRow[];
	artifacts: ArtifactRow[];
	profile: Profile;
	chats: ChatRecord[];
	attachments: ManagedAttachment[];
};

/**
 * Every frame the real daemon can push: a copy of `ConsoleEvent` in
 * src/daemon/console-api.ts, which the website cannot import (it pulls in the
 * daemon). tests/website-mock-parity.test.ts fails when the two drift.
 */
export type ConsoleFrame =
	| { type: "plan"; room: string }
	| { type: "chat"; chatId: string; event: unknown }
	| { type: "message"; message: RoomMessage }
	| { type: "reaction"; room: string; messageId: number; actor: string; emoji: string; reacted: boolean }
	| { type: "agent"; agent: string; state: AgentState }
	| { type: "definition"; agent: string; rebuildRequired: boolean }
	| { type: "membership"; agent: string; rooms: string[] }
	| { type: "channel"; channel: RoomInfo }
	| { type: "budget"; account: string; state: "parked" | "resumed" | "bumped" | "warned"; budgetUsd?: number }
	| { type: "schedule"; agent: string; phase: "armed" | "fired" }
	| { type: "profile" };
