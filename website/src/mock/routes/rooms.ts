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

// src/rooms/plans.ts: every refusal is 400 with the code as its message,
// except a stale revision, which src/daemon/web-routes.ts answers 409.
const STATUSES: PlanStatus[] = ["draft", "active", "completed"];
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 1_048_576;
const planError = (code: "INVALID_PLAN" | "ROOM_NOT_FOUND" | "PLAN_NOT_FOUND" | "PLAN_REVISION_CONFLICT"): never =>
	fail(code === "PLAN_REVISION_CONFLICT" ? 409 : 400, code, code);

/** Non-blank and short, stored as sent (the daemon does not trim). */
function planTitle(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TITLE_LENGTH) planError("INVALID_PLAN");
	return value as string;
}

/** Any string up to the cap; an empty body is a valid plan. */
function planBody(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_BODY_LENGTH) planError("INVALID_PLAN");
	return value as string;
}

function planRoom(id: string): void {
	if (!getState().channels.some((room) => room.id === id)) planError("ROOM_NOT_FOUND");
}

/** The daemon parses plan bodies itself and answers a missing one as a workspace error. */
const planPayload = (ctx: { body: Record<string, unknown> | undefined }) => ctx.body ?? fail(400, "workspace_error", "JSON body is required");

export const roomRoutes: Route[] = [
	route("GET", /^\/api\/channels$/, () => ok({ channels: getState().channels })),

	route("POST", /^\/api\/channels$/, (ctx) => {
		const body = requireBody(ctx);
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (!id) fail(400, "invalid_request", "Channel id is required");
		const workspace = workspaceFrom(body.workspace);
		const existed = getState().channels.some((r) => r.id === id);
		let room = ensureRoom(id, false);
		if (workspace !== undefined) {
			room = { ...room, workspace };
			const next = room;
			update((s) => ({ ...s, channels: s.channels.map((r) => (r.id === id ? next : r)) }));
		}
		// One frame, and only for a room the console has not seen yet.
		if (!existed) publish({ type: "channel", channel: room });
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
		const cursor = (name: string) => {
			const raw = ctx.url.searchParams.get(name);
			if (raw === null) return undefined;
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 0) fail(400, "invalid_request", `${name} must be an integer`);
			return value;
		};
		const afterId = cursor("afterId");
		const beforeId = cursor("beforeId");
		const newest = ctx.url.searchParams.get("newest") === "1";
		const rawLimit = ctx.url.searchParams.get("limit");
		const limit = rawLimit === null ? 500 : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, "invalid_request", "limit must be 1..500");
		// As the daemon pages: `afterId` and plain `limit` take the oldest N
		// (after the cursor); `beforeId` takes the N just before that id and
		// `newest=1` the latest N. Always ascending.
		const all = roomMessages(id);
		const page =
			afterId !== undefined
				? all.filter((m) => m.id > afterId).slice(0, limit)
				: beforeId !== undefined
					? all.filter((m) => m.id < beforeId).slice(-limit)
					: newest
						? all.slice(-limit)
						: all.slice(0, limit);
		// A reply whose thread root is older than the page brings that root along, first.
		const onPage = new Set(page.map((m) => m.id));
		const roots = all.filter((m) => !onPage.has(m.id) && page.some((reply) => reply.threadRootId === m.id));
		return ok({ messages: [...roots, ...page] });
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
		planRoom(room);
		const plans = getState().plans.filter((plan) => plan.room === room).sort((a, b) => b.updatedAt - a.updatedAt);
		return ok({ plans });
	}),

	route("POST", /^\/api\/channels\/([^/]+)\/plans$/, (ctx) => {
		const room = decode(ctx.params[0]);
		const body = planPayload(ctx);
		const title = planTitle(body.title);
		const text = planBody(body.body);
		planRoom(room);
		const now = Date.now();
		const plan: RoomPlan = {
			id: `plan-${now.toString(36)}`,
			room,
			title,
			body: text,
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
		const body = planPayload(ctx);
		const revision = body.expectedRevision;
		if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) planError("INVALID_PLAN");
		if (body.title === undefined && body.body === undefined && body.status === undefined) planError("INVALID_PLAN");
		const title = body.title === undefined ? undefined : planTitle(body.title);
		const text = body.body === undefined ? undefined : planBody(body.body);
		if (body.status !== undefined && !STATUSES.includes(body.status as PlanStatus)) planError("INVALID_PLAN");
		planRoom(room);
		const existing = getState().plans.find((plan) => plan.id === id && plan.room === room) ?? planError("PLAN_NOT_FOUND");
		if (revision !== existing.revision) planError("PLAN_REVISION_CONFLICT");
		const plan: RoomPlan = {
			...existing,
			...(title === undefined ? {} : { title }),
			...(text === undefined ? {} : { body: text }),
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
