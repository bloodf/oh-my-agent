/** Channels, DMs, transcripts, reactions, and durable plans. */
import { answerOperator } from "../activity";
import { publish } from "../bus";
import { isDirectory, normalizePath } from "../fixtures/workspace";
import { decode, fail, ok, requireBody, route, type Route } from "../http";
import { ensureRoom, postMessage, roomMessages, setReaction } from "../messages";
import { getState, update } from "../store";
import type { PlanStatus, RoomInfo, RoomPlan } from "../types";

const HUMAN = "@you";

export function workspaceFrom(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.startsWith("/")) fail(400, "invalid_workspace", "workspace must be an absolute directory");
	const path = normalizePath(value as string);
	if (!isDirectory(path)) fail(400, "invalid_workspace", `workspace is not a real directory: ${value}`);
	return path;
}

function knownRoom(id: string): RoomInfo {
	return getState().channels.find((room) => room.id === id) ?? fail(404, "not_found", `Unknown channel: ${id}`);
}

const STATUSES: PlanStatus[] = ["draft", "active", "completed"];

function planText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(400, "PLAN_INVALID", `${field} is required`);
	if ((value as string).length > max) fail(400, "PLAN_INVALID", `${field} exceeds ${max} characters`);
	return (value as string).trim();
}

export const roomRoutes: Route[] = [
	route("GET", /^\/api\/channels$/, () => ok({ channels: getState().channels })),

	route("POST", /^\/api\/channels$/, (ctx) => {
		const body = requireBody(ctx);
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (!id) fail(400, "invalid_request", "Channel id is required");
		const workspace = workspaceFrom(body.workspace);
		let room = ensureRoom(id);
		if (workspace !== undefined) {
			room = { ...room, workspace };
			const next = room;
			update((s) => ({ ...s, channels: s.channels.map((r) => (r.id === id ? next : r)) }));
			publish({ type: "channel", channel: room });
		}
		return ok({ channel: room }, 201);
	}),

	route("PATCH", /^\/api\/channels\/([^/]+)$/, (ctx) => {
		const id = decode(ctx.params[0]);
		const existing = knownRoom(id);
		const body = requireBody(ctx);
		if (!("workspace" in body)) fail(400, "invalid_request", "workspace is required");
		const workspace = body.workspace === null ? undefined : workspaceFrom(body.workspace);
		const { workspace: _previous, ...rest } = existing;
		const channel: RoomInfo = workspace === undefined ? rest : { ...rest, workspace };
		update((s) => ({ ...s, channels: s.channels.map((r) => (r.id === id ? channel : r)) }));
		publish({ type: "channel", channel });
		return ok({ channel });
	}),

	route("GET", /^\/api\/channels\/([^/]+)\/messages$/, (ctx) => {
		const id = decode(ctx.params[0]);
		knownRoom(id);
		const rawAfter = ctx.url.searchParams.get("afterId");
		const rawLimit = ctx.url.searchParams.get("limit");
		const afterId = rawAfter === null ? 0 : Number(rawAfter);
		if (!Number.isInteger(afterId) || afterId < 0) fail(400, "invalid_request", "afterId must be an integer");
		const limit = rawLimit === null ? 500 : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, "invalid_request", "limit must be 1..500");
		const after = roomMessages(id).filter((m) => m.id > afterId);
		return ok({ messages: rawAfter === null ? after.slice(-limit) : after.slice(0, limit) });
	}),

	route("POST", /^\/api\/channels\/([^/]+)\/messages$/, (ctx) => {
		const id = decode(ctx.params[0]);
		knownRoom(id);
		const body = requireBody(ctx);
		const text = typeof body.body === "string" ? body.body.trim() : "";
		if (!text) fail(400, "invalid_request", "Message body is required");
		let parentId: number | null = null;
		if (body.parentId !== undefined && body.parentId !== null) {
			if (typeof body.parentId !== "number" || !Number.isInteger(body.parentId) || body.parentId < 1)
				fail(400, "invalid_request", "parentId must be a positive integer message id");
			parentId = body.parentId as number;
		}
		// ADR-014: the console always speaks as the human, whatever `author` says.
		const message = postMessage(id, HUMAN, text, parentId);
		answerOperator(message);
		return ok({ message }, 201);
	}),

	route("POST", /^\/api\/messages\/(\d+)\/reactions\/toggle$/, (ctx) => {
		const body = requireBody(ctx);
		const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";
		if (!emoji) fail(400, "invalid_request", "An emoji is required");
		const messageId = Number(ctx.params[0]);
		const { reacted } = setReaction(messageId, HUMAN, emoji);
		return ok({ messageId, actor: HUMAN, emoji, reacted });
	}),

	route("GET", /^\/api\/channels\/([^/]+)\/plans$/, (ctx) => {
		const room = decode(ctx.params[0]);
		const plans = getState().plans.filter((plan) => plan.room === room).sort((a, b) => b.updatedAt - a.updatedAt);
		return ok({ plans });
	}),

	route("POST", /^\/api\/channels\/([^/]+)\/plans$/, (ctx) => {
		const room = decode(ctx.params[0]);
		const body = requireBody(ctx);
		const now = Date.now();
		const plan: RoomPlan = {
			id: `plan-${now.toString(36)}`,
			room,
			title: planText(body.title, "title", 200),
			body: planText(body.body, "body", 100_000),
			status: "draft",
			revision: 1,
			author: HUMAN,
			updatedBy: HUMAN,
			createdAt: now,
			updatedAt: now,
		};
		update((s) => ({ ...s, plans: [...s.plans, plan] }));
		publish({ type: "plan", room });
		return ok({ plan }, 201);
	}),

	route("PATCH", /^\/api\/channels\/([^/]+)\/plans\/([^/]+)$/, (ctx) => {
		const room = decode(ctx.params[0]);
		const id = decode(ctx.params[1]);
		const body = requireBody(ctx);
		const existing = getState().plans.find((plan) => plan.id === id && plan.room === room) ?? fail(404, "PLAN_NOT_FOUND", "PLAN_NOT_FOUND");
		if (body.expectedRevision !== existing.revision) fail(409, "PLAN_REVISION_CONFLICT", "PLAN_REVISION_CONFLICT");
		if (body.status !== undefined && !STATUSES.includes(body.status as PlanStatus)) fail(400, "PLAN_INVALID", "status must be draft, active, or completed");
		const plan: RoomPlan = {
			...existing,
			...(body.title === undefined ? {} : { title: planText(body.title, "title", 200) }),
			...(body.body === undefined ? {} : { body: planText(body.body, "body", 100_000) }),
			...(body.status === undefined ? {} : { status: body.status as PlanStatus }),
			revision: existing.revision + 1,
			updatedBy: HUMAN,
			updatedAt: Date.now(),
		};
		update((s) => ({ ...s, plans: s.plans.map((p) => (p.id === id ? plan : p)) }));
		publish({ type: "plan", room });
		return ok({ plan });
	}),
];
