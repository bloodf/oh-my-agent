/** File picker, Git changes, managed uploads, and independent OMP chats. */
import { abortChat, streamChatReply } from "../activity";
import { publish } from "../bus";
import { CHAT_MODELS } from "../fixtures/chats";
import { BINARY_PATHS, isDirectory, isFile, listDirectory, normalizePath, repoFor, UPLOAD_ROOT } from "../fixtures/workspace";
import { decode, fail, ok, requireBody, route, type Route } from "../http";
import { getState, update } from "../store";
import type { ChatRecord, ManagedAttachment } from "../types";

const MAX_DIFF = 64_000;

/** The daemon answers workspace failures as 400 `workspace_error`. */
const refuse = (message: string): never => fail(400, "workspace_error", message);

function chat(id: string): ChatRecord {
	return getState().chats.find((c) => c.info.id === id) ?? refuse(`Unknown chat: ${id}`);
}

function attachmentText(paths: unknown): string {
	if (paths === undefined) return "";
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) refuse("paths must be a list of absolute file paths");
	const list = paths as string[];
	if (list.length > 20) refuse("A prompt accepts at most 20 file paths");
	for (const path of list) {
		const uploaded = getState().attachments.some((a) => a.path === path);
		if (!path.startsWith("/") || !(uploaded || isFile(path))) refuse(`Not a readable file: ${path}`);
	}
	return list.length ? `\n\nAttached files:\n${list.map((p) => `- ${p}`).join("\n")}` : "";
}

/** Store an upload the fake XHR finished streaming. */
export function recordUpload(name: string, type: string, size: number): ManagedAttachment {
	const id = `upl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const attachment: ManagedAttachment = { id, name, type, size, path: `${UPLOAD_ROOT}/${id}/${name}` };
	update((s) => ({ ...s, attachments: [...s.attachments, attachment] }));
	return attachment;
}

export const workspaceRoutes: Route[] = [
	route("GET", /^\/api\/workspace\/files$/, (ctx) => {
		const requested = ctx.url.searchParams.get("path") ?? "";
		const listing = listDirectory(requested.trim() === "" ? "/Users/you" : requested);
		if (!listing) refuse(`ENOENT: no such directory, scandir '${requested}'`);
		return ok({ ...listing, truncated: false });
	}),

	route("GET", /^\/api\/workspace\/changes$/, (ctx) => {
		const cwd = ctx.url.searchParams.get("cwd") ?? "";
		if (!cwd.startsWith("/") || !isDirectory(cwd)) refuse(`Workspace is not a directory: ${cwd}`);
		const repo = repoFor(cwd) ?? refuse(`Not a Git repository: ${normalizePath(cwd)}`);
		return ok({ cwd: normalizePath(cwd), root: repo.root, branch: repo.branch, files: repo.files });
	}),

	route("GET", /^\/api\/workspace\/diff$/, (ctx) => {
		const cwd = ctx.url.searchParams.get("cwd") ?? "";
		const path = ctx.url.searchParams.get("path") ?? "";
		const staged = ctx.url.searchParams.get("staged") === "true";
		const repo = repoFor(cwd) ?? refuse(`Not a Git repository: ${cwd}`);
		if (!repo.files.some((file) => file.path === path)) refuse(`Path is not a reported change: ${path}`);
		const diff = repo.diffs[`${staged ? "staged" : "working"}:${path}`] ?? "";
		return ok({ path, diff: diff.slice(0, MAX_DIFF), truncated: diff.length > MAX_DIFF, binary: BINARY_PATHS.has(path) });
	}),

	route("GET", /^\/api\/attachments$/, () => ok({ attachments: getState().attachments })),

	// Browsers upload through XMLHttpRequest; a fetch upload is accepted too.
	route("POST", /^\/api\/attachments$/, (ctx) => {
		const encoded = ctx.headers["x-attachment-name"];
		if (!encoded || encoded.length > 1200) refuse("Attachment name is required");
		return ok(recordUpload(decode(encoded), ctx.headers["content-type"] || "application/octet-stream", 0), 201);
	}),

	route("DELETE", /^\/api\/attachments\/([^/]+)$/, (ctx) => {
		const id = decode(ctx.params[0]);
		if (!getState().attachments.some((a) => a.id === id)) refuse(`Unknown attachment: ${id}`);
		update((s) => ({ ...s, attachments: s.attachments.filter((a) => a.id !== id) }));
		return ok(null, 204);
	}),

	route("GET", /^\/api\/chats$/, () => ok({ chats: getState().chats.map((c) => c.info) })),

	route("POST", /^\/api\/chats$/, (ctx) => {
		const body = requireBody(ctx);
		if (typeof body.cwd !== "string") refuse("Workspace folder is required");
		for (const key of ["title", "provider", "modelId"]) if (body[key] !== undefined && typeof body[key] !== "string") refuse(`Invalid ${key}`);
		const cwd = normalizePath(body.cwd as string);
		if (!cwd.startsWith("/") || !isDirectory(cwd)) refuse(`Workspace is not a directory: ${body.cwd}`);
		const now = Date.now();
		const id = `chat-${now.toString(16).slice(-4)}`;
		const model = CHAT_MODELS.find((m) => m.provider === body.provider && m.id === body.modelId) ?? CHAT_MODELS[1];
		const title = (body.title as string | undefined)?.trim() || `OMP in ${cwd.split("/").pop()}`;
		const info = { id, title, cwd, createdAt: now, updatedAt: now, provider: model?.provider, modelId: model?.id };
		const record: ChatRecord = {
			info,
			state: {
				...info,
				running: true,
				streaming: false,
				compacting: false,
				sessionId: `01K${now.toString(36).toUpperCase()}`,
				...(model ? { model: { provider: model.provider, id: model.id } } : {}),
				messageCount: 0,
				queuedMessageCount: 0,
				todoPhases: [],
			},
			messages: [],
			models: CHAT_MODELS,
		};
		update((s) => ({ ...s, chats: [...s.chats, record] }));
		return ok({ chat: info }, 201);
	}),

	route("DELETE", /^\/api\/chats\/([^/]+)$/, (ctx) => {
		const id = decode(ctx.params[0]);
		chat(id);
		abortChat(id);
		update((s) => ({ ...s, chats: s.chats.filter((c) => c.info.id !== id) }));
		return ok({ closed: true });
	}),

	route("GET", /^\/api\/chats\/([^/]+)\/state$/, (ctx) => ok({ state: chat(decode(ctx.params[0])).state })),
	route("GET", /^\/api\/chats\/([^/]+)\/messages$/, (ctx) => ok({ messages: chat(decode(ctx.params[0])).messages })),
	route("GET", /^\/api\/chats\/([^/]+)\/models$/, (ctx) => ok({ models: chat(decode(ctx.params[0])).models })),

	route("POST", /^\/api\/chats\/([^/]+)\/model$/, (ctx) => {
		const id = decode(ctx.params[0]);
		const body = requireBody(ctx);
		const model = chat(id).models.find((m) => m.provider === body.provider && m.id === body.modelId) ?? refuse(`Unknown model: ${String(body.provider)}/${String(body.modelId)}`);
		const selected = { provider: model.provider, id: model.id };
		update((s) => ({
			...s,
			chats: s.chats.map((c) =>
				c.info.id !== id ? c : { ...c, info: { ...c.info, provider: model.provider, modelId: model.id }, state: { ...c.state, provider: model.provider, modelId: model.id, model: selected } },
			),
		}));
		return ok(selected);
	}),

	route("POST", /^\/api\/chats\/([^/]+)\/prompt$/, (ctx) => {
		const id = decode(ctx.params[0]);
		const record = chat(id);
		const body = requireBody(ctx);
		if (typeof body.message !== "string" || body.message.length > 1024 * 1024) refuse("Invalid chat message");
		const refs = attachmentText(body.paths);
		if (!(body.message as string).trim() && !refs) refuse("Message is empty");
		if (record.state.streaming) refuse("OMP is still answering; stop it or wait for the turn to end");
		const now = Date.now();
		update((s) => ({
			...s,
			chats: s.chats.map((c) =>
				c.info.id !== id ? c : { ...c, messages: [...c.messages, { role: "user", timestamp: now, content: `${body.message as string}${refs}` }] },
			),
		}));
		publish({ type: "chat", chatId: id, event: { type: "message_end", message: { role: "user" } } });
		streamChatReply(id);
		return ok({ accepted: true }, 202);
	}),

	route("POST", /^\/api\/chats\/([^/]+)\/abort$/, (ctx) => {
		const id = decode(ctx.params[0]);
		chat(id);
		abortChat(id);
		return ok({ aborted: true });
	}),
];
