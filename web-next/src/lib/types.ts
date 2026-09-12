export const HUMAN_AUTHOR = "@you";
export type RoomInfo = {
	id: string;
	kind: "channel" | "dm";
	name?: string;
	workspace?: string;
};
export type MessageReaction = { actor: string; emoji: string };
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
	model?: string;
	rooms?: string[];
	lastError?: string;
};
export type Plan = {
	id: string;
	room: string;
	title: string;
	body: string;
	status: string;
	revision: number;
	updatedBy: string;
	updatedAt: number;
};
export type Persona = { displayName?: string; avatar?: string };
export type Profile = { operator: Persona; agents: Record<string, Persona> };
export type Artifact = {
	file: string;
	url: string;
	status: string;
	pendingPrompts: number;
	updatedAt: string;
};
export type Schedule = {
	id: string;
	agent: string;
	cron: string | null;
	action: string;
	nextFireAt: number | null;
	enabled: boolean;
};

export function personaFor(
	profile: Profile,
	author: string,
): { name: string; avatar: string } {
	const persona =
		author === HUMAN_AUTHOR ? profile.operator : profile.agents[author];
	const initials =
		author
			.replace(/^@/, "")
			.split(/[-_.\s]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p[0]?.toUpperCase() ?? "")
			.join("") || "?";
	return {
		name: persona?.displayName ?? author,
		avatar: persona?.avatar ?? initials,
	};
}
