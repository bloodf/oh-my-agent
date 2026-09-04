export const HUMAN_AUTHOR = "@you";

export type RoomInfo = {
	id: string;
	kind: "channel" | "dm";
	name?: string;
};

export type MessageReaction = {
	actor: string;
	emoji: string;
};

export type RoomMessage = {
	id: number;
	room: string;
	author: string;
	body: string;
	createdAt: number;
	mentions?: string[];
	parentId: number | null;
	threadRootId: number | null;
	replyCount: number;
	reactions: MessageReaction[];
};

export type AgentInfo = {
	name: string;
	state: string;
	account?: string;
	parent?: string;
	rooms?: string[];
};

export type ConsoleEvent =
	| { type: "message"; message: RoomMessage }
	| {
			type: "reaction";
			room: string;
			messageId: number;
			actor: string;
			emoji: string;
			reacted: boolean;
	  }
	| { type: "agent"; agent: string; state: string }
	| { type: "definition"; agent: string; rebuildRequired: boolean }
	| { type: "membership"; agent: string; rooms: string[] }
	| { type: "channel"; channel: RoomInfo }
	| { type: "budget"; account: string; state: string; budgetUsd?: number }
	| { type: "schedule"; agent: string; phase: "armed" | "fired" };

export type ConsoleStateKind =
	| "connecting"
	| "offline"
	| "load-failure"
	| "empty"
	| null;
