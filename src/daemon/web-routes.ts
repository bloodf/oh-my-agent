import type { RoomPlans } from "../rooms/plans";
import { RoomPlanError } from "../rooms/plans";
import type { WebChats } from "../shared/web-workspace";
import type { WebAttachments } from "./web-attachments";
import { attachmentReferences, listWebFiles } from "./web-files";
import { inspectWorkspace, readWorkspaceDiff } from "./workspace-changes";

export interface WebServices {
	chats: WebChats;
	plans: RoomPlans;
	clipboard: WebAttachments;
	remoteFullControl: boolean;
}
const json = (status: number, value: unknown) =>
	Response.json(value, { status });
/** Called only after console authentication, with server-derived remote identity. */
export async function handleWebRoute(
	request: Request,
	url: URL,
	services: WebServices,
	remoteRequest: boolean,
	onPlanChanged: (room: string) => void,
): Promise<Response | undefined> {
	const path = url.pathname;
	const privileged =
		path.startsWith("/api/chats") ||
		path.startsWith("/api/workspace/") ||
		path === "/api/clipboard";
	if (path === "/api/capabilities")
		return json(200, {
			fullControl: !remoteRequest || services.remoteFullControl,
		});
	const planMatch = /^\/api\/channels\/([^/]+)\/plans(?:\/([^/]+))?$/.exec(
		path,
	);
	if (!privileged && !planMatch) return;
	if (privileged && remoteRequest && !services.remoteFullControl)
		return json(403, {
			error: {
				code: "remote_control_disabled",
				message:
					"Full OMP control is disabled remotely. Set OMA_REMOTE_FULL_CONTROL=1 on the daemon to opt in.",
			},
		});
	try {
		if (planMatch?.[1] !== undefined) {
			const room = decodeURIComponent(planMatch[1]);
			const id = planMatch[2];
			if (request.method === "GET" && !id)
				return json(200, { plans: services.plans.list(room) });
			const body = (await request.json()) as Record<string, unknown>;
			if (request.method === "POST" && !id) {
				const plan = services.plans.create({
					room,
					title: body.title as string,
					body: body.body as string,
					author: "@you",
				});
				onPlanChanged(room);
				return json(201, { plan });
			}
			if (request.method === "PATCH" && id) {
				const plan = services.plans.update({
					id: decodeURIComponent(id),
					room,
					expectedRevision: body.expectedRevision as number,
					author: "@you",
					...(body.title === undefined ? {} : { title: body.title as string }),
					...(body.body === undefined ? {} : { body: body.body as string }),
					...(body.status === undefined
						? {}
						: { status: body.status as "draft" | "active" | "completed" }),
				});
				onPlanChanged(room);
				return json(200, { plan });
			}
		}
		if (path === "/api/workspace/files" && request.method === "GET")
			return json(200, await listWebFiles(url.searchParams.get("path") ?? ""));
		if (path === "/api/workspace/changes" && request.method === "GET")
			return json(
				200,
				await inspectWorkspace(url.searchParams.get("cwd") ?? ""),
			);
		if (path === "/api/workspace/diff" && request.method === "GET")
			return json(
				200,
				await readWorkspaceDiff(
					url.searchParams.get("cwd") ?? "",
					url.searchParams.get("path") ?? "",
					url.searchParams.get("staged") === "true",
				),
			);
		if (path === "/api/clipboard" && request.method === "POST") {
			const length = Number(request.headers.get("content-length"));
			if (!Number.isFinite(length) || length <= 0 || length > 12 * 1024 * 1024)
				return json(413, {
					error: {
						code: "too_large",
						message: "Clipboard image must be at most 12 MiB",
					},
				});
			const body = await request.formData();
			const file = body.get("image");
			if (
				!(file instanceof File) ||
				!/^image\/(png|jpeg|webp|gif)$/.test(file.type)
			)
				throw new Error("Only clipboard images are accepted");
			const image = await services.clipboard.upload(file);
			return json(201, { path: image.path });
		}
		if (path === "/api/chats") {
			if (request.method === "GET")
				return json(200, { chats: await services.chats.list() });
			if (request.method === "POST") {
				const body = await request.json();
				if (
					!body ||
					typeof body !== "object" ||
					!("cwd" in body) ||
					typeof body.cwd !== "string"
				)
					throw new Error("Workspace folder is required");
				const fields = body as Record<string, unknown>;
				for (const key of ["title", "provider", "modelId"])
					if (fields[key] !== undefined && typeof fields[key] !== "string")
						throw new Error(`Invalid ${key}`);
				return json(201, {
					chat: await services.chats.create({
						cwd: body.cwd,
						...(fields.title === undefined
							? {}
							: { title: fields.title as string }),
						...(fields.provider === undefined
							? {}
							: { provider: fields.provider as string }),
						...(fields.modelId === undefined
							? {}
							: { modelId: fields.modelId as string }),
					}),
				});
			}
		}
		const chatMatch =
			/^\/api\/chats\/([^/]+)(?:\/(state|messages|models|model|prompt|abort))?$/.exec(
				path,
			);
		if (chatMatch?.[1] !== undefined) {
			const id = decodeURIComponent(chatMatch[1]);
			const action = chatMatch[2];
			if (request.method === "GET") {
				if (action === "state")
					return json(200, { state: await services.chats.state(id) });
				if (action === "messages")
					return json(200, { messages: await services.chats.messages(id) });
				if (action === "models")
					return json(200, { models: await services.chats.models(id) });
			}
			if (request.method === "DELETE" && !action) {
				await services.chats.closeChat(id);
				return json(200, { closed: true });
			}
			if (request.method === "POST") {
				if (action === "abort") {
					await services.chats.abort(id);
					return json(200, { aborted: true });
				}
				const body = (await request.json()) as Record<string, unknown>;
				if (action === "model")
					return json(
						200,
						await services.chats.setModel(id, {
							provider: body.provider as string,
							modelId: body.modelId as string,
						}),
					);
				if (action === "prompt") {
					if (
						typeof body.message !== "string" ||
						body.message.length > 1024 * 1024
					)
						throw new Error("Invalid chat message");
					const refs = await attachmentReferences(body.paths);
					if (!body.message.trim() && !refs)
						throw new Error("Message is empty");
					await services.chats.prompt(id, { message: body.message + refs });
					return json(202, { accepted: true });
				}
			}
		}
		return json(405, {
			error: {
				code: "method_not_allowed",
				message: "Unsupported workspace operation",
			},
		});
	} catch (error) {
		const status =
			error instanceof RoomPlanError && error.code === "PLAN_REVISION_CONFLICT"
				? 409
				: 400;
		return json(status, {
			error: {
				code: error instanceof RoomPlanError ? error.code : "workspace_error",
				message: error instanceof Error ? error.message : String(error),
			},
		});
	}
}
