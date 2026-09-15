/**
 * Room writes shared by the HTTP routes and the simulated agents: posting,
 * reacting, ensuring a room exists. Each commits state, then publishes.
 */
import { publish } from "./bus";
import { fail } from "./http";
import { getState, update } from "./store";
import type { RoomInfo, RoomMessage, StoredMessage } from "./types";

/** Keep a long-open tab from growing a room without bound. */
const ROOM_CAP = 400;

export function toWire(message: StoredMessage, all: StoredMessage[]): RoomMessage {
	const byId = new Map(all.map((m) => [m.id, m]));
	const rootOf = (m: StoredMessage): number | null => {
		let parent = m.parentId === null ? undefined : byId.get(m.parentId);
		if (!parent) return null;
		while (parent.parentId !== null && byId.has(parent.parentId)) parent = byId.get(parent.parentId) as StoredMessage;
		return parent.id;
	};
	return {
		...message,
		threadRootId: rootOf(message),
		replyCount: all.filter((m) => m.room === message.room && m.id !== message.id && rootOf(m) === message.id).length,
	};
}

export function roomMessages(room: string): RoomMessage[] {
	const all = getState().messages.filter((m) => m.room === room);
	return all.map((m) => toWire(m, all));
}

/** `announce: false` leaves the `channel` frame to a caller that is still shaping the room. */
export function ensureRoom(id: string, announce = true): RoomInfo {
	const existing = getState().channels.find((room) => room.id === id);
	if (existing) return existing;
	const room: RoomInfo = { id, kind: id.startsWith("@") ? "dm" : "channel", name: id };
	update((state) => ({ ...state, channels: [...state.channels, room] }));
	if (announce) publish({ type: "channel", channel: room });
	return room;
}

function mentionsIn(body: string): string[] {
	const names = new Set(getState().agents.map((agent) => agent.name));
	return [...new Set([...body.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)].map((m) => m[1] ?? ""))].filter((name) => names.has(name));
}

export function postMessage(room: string, author: string, body: string, parentId: number | null): RoomMessage {
	const state = getState();
	if (!state.channels.some((r) => r.id === room)) fail(404, "not_found", `Unknown channel: ${room}`);
	if (parentId !== null) {
		const parent = state.messages.find((m) => m.id === parentId);
		if (!parent) fail(400, "invalid_request", "MESSAGE_NOT_FOUND");
		if (parent?.room !== room) fail(400, "invalid_request", "MESSAGE_NOT_IN_ROOM");
	}
	const stored: StoredMessage = {
		id: state.nextMessageId,
		room,
		author,
		body,
		createdAt: Date.now(),
		mentions: mentionsIn(body),
		parentId,
		reactions: [],
	};
	update((s) => {
		const inRoom = s.messages.filter((m) => m.room === room);
		const drop = inRoom.length >= ROOM_CAP ? new Set(inRoom.slice(0, inRoom.length - ROOM_CAP + 1).map((m) => m.id)) : new Set<number>();
		return { ...s, nextMessageId: s.nextMessageId + 1, messages: [...s.messages.filter((m) => !drop.has(m.id)), stored] };
	});
	const message = roomMessages(room).find((m) => m.id === stored.id) as RoomMessage;
	publish({ type: "message", message });
	return message;
}

export function setReaction(messageId: number, actor: string, emoji: string, reacted?: boolean): { room: string; reacted: boolean } {
	const message = getState().messages.find((m) => m.id === messageId) ?? fail(404, "not_found", `Unknown message: ${messageId}`);
	const mine = message.reactions.some((r) => r.actor === actor && r.emoji === emoji);
	const next = reacted ?? !mine;
	if (next !== mine) {
		update((s) => ({
			...s,
			messages: s.messages.map((m) =>
				m.id !== messageId
					? m
					: {
							...m,
							reactions: next
								? [...m.reactions, { actor, emoji }]
								: m.reactions.filter((r) => !(r.actor === actor && r.emoji === emoji)),
						},
			),
		}));
		publish({ type: "reaction", room: message.room, messageId, actor, emoji, reacted: next });
	}
	return { room: message.room, reacted: next };
}
