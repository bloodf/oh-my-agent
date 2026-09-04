import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConsoleApi, ConsoleEvent } from "../src/daemon/console-api";
import { startConsoleApi } from "../src/daemon/console-api";
import { bootDaemon } from "../src/daemon/main";
import { createOperations } from "../src/daemon/operations";
import { createPeerStore } from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
import { Supervisor } from "../src/daemon/supervisor";
import { WebAttachments } from "../src/daemon/web-attachments";
import { createWebChats } from "../src/daemon/web-chats";
import { RoomPlans } from "../src/rooms/plans";
import { RoomStore } from "../src/rooms/store";
import type { RoomInfo } from "../src/shared/protocol";

interface WorkspaceHarness {
	api: ConsoleApi;
	remoteHeaders: Record<string, string>;
	call(path: string, remote: boolean): Promise<Response>;
}
const TOKEN = "workspace-operator-token";
const PROXY_SECRET = "workspace-proxy-secret";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix = "oma-workspace-security-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function harness(remoteFullControl: boolean): Promise<WorkspaceHarness> {
	const dir = await tempDir();
	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(() => rooms.close());
	const plans = await RoomPlans.open(rooms.path);
	cleanups.push(() => plans.close());
	const chats = await createWebChats({ stateDir: join(dir, "state") });
	cleanups.push(async () => {
		await chats.close();
		await rm(chats.storageDir, { recursive: true, force: true });
	});

	const scheduler = new Scheduler({
		now: Date.now,
		setTimer: () => 0,
		clearTimer: () => {},
	});
	const supervisor = new Supervisor({ rooms, scheduler, now: Date.now });
	const peers = new Map<string, PeerRecord>();
	const roots = {
		user: join(dir, "user", "agents"),
		project: join(dir, "project", "agents"),
	};
	await mkdir(roots.user, { recursive: true });
	await mkdir(roots.project, { recursive: true });
	const peerStore = createPeerStore(roots);
	const operations = createOperations({
		rooms,
		supervisor,
		peers,
		bumpAccount: async () => [],
	});
	const knownRooms = new Map<string, RoomInfo>();
	const api = await startConsoleApi({
		rooms,
		supervisor,
		peers,
		peerStore,
		knownRooms,
		ensureRoom: async (id) => {
			if (knownRooms.has(id)) return;
			const kind = id.startsWith("@") ? "dm" : "channel";
			await rooms.createRoom({ id, kind });
			knownRooms.set(id, { id, kind, name: id });
		},
		operations,
		token: TOKEN,
		remoteMode: true,
		proxySecret: PROXY_SECRET,
		web: {
			chats,
			plans,
			clipboard: new WebAttachments(join(chats.storageDir, "clipboard")),
			remoteFullControl,
		},
	});
	cleanups.push(() => api.close());
	const direct = new URL(api.url);
	const remoteHeaders = {
		Authorization: `Bearer ${TOKEN}`,
		"X-OMA-Proxy-Secret": PROXY_SECRET,
		"X-Forwarded-Proto": direct.protocol.slice(0, -1),
		"X-Forwarded-Host": direct.host,
	};
	return {
		api,
		remoteHeaders,
		call: (path, remote) =>
			fetch(`${api.url}${path}`, {
				headers: remote ? remoteHeaders : { Authorization: `Bearer ${TOKEN}` },
			}),
	};
}

function opened(socket: WebSocket): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => resolve(), { once: true });
	socket.addEventListener(
		"error",
		() => reject(new Error("websocket errored")),
		{
			once: true,
		},
	);
	return promise;
}

async function remoteSocket(h: WorkspaceHarness): Promise<WebSocket> {
	const ticketResponse = await fetch(`${h.api.url}/api/ws-ticket`, {
		method: "POST",
		headers: h.remoteHeaders,
	});
	expect(ticketResponse.status).toBe(200);
	const { ticket } = (await ticketResponse.json()) as { ticket: string };
	const url = new URL("/api/events", h.api.url);
	url.protocol = "ws:";
	url.searchParams.set("ticket", ticket);
	const socket = new WebSocket(url, { headers: h.remoteHeaders });
	cleanups.push(async () => socket.close());
	await opened(socket);
	return socket;
}

async function localSocket(h: WorkspaceHarness): Promise<WebSocket> {
	const url = new URL("/api/events", h.api.url);
	url.protocol = "ws:";
	url.searchParams.set("token", TOKEN);
	const socket = new WebSocket(url);
	cleanups.push(async () => socket.close());
	await opened(socket);
	return socket;
}

function framesThroughBarrier(socket: WebSocket): Promise<ConsoleEvent[]> {
	const { promise, resolve, reject } = Promise.withResolvers<ConsoleEvent[]>();
	const frames: ConsoleEvent[] = [];
	const cleanup = () => {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("close", onClose);
		socket.removeEventListener("error", onError);
	};
	const fail = (message: string) => {
		cleanup();
		reject(new Error(message));
	};
	const onClose = () => fail("websocket closed before room barrier");
	const onError = () => fail("websocket errored before room barrier");
	const onMessage = (message: MessageEvent) => {
		const frame = JSON.parse(String(message.data)) as ConsoleEvent;
		frames.push(frame);
		if (frame.type !== "plan") return;
		cleanup();
		resolve(frames);
	};
	socket.addEventListener("message", onMessage);
	socket.addEventListener("close", onClose, { once: true });
	socket.addEventListener("error", onError, { once: true });
	return promise;
}

describe("remote workspace full-control boundary", () => {
	test("trusted proxy identity denies files and chats by default and opt-in restores them", async () => {
		const denied = await harness(false);
		const allowed = await harness(true);
		const encodedDir = encodeURIComponent(
			await tempDir("oma-visible-workspace-"),
		);

		for (const path of [
			`/api/workspace/files?path=${encodedDir}`,
			"/api/chats",
		]) {
			expect((await denied.call(path, false)).status).toBe(200);
			const refusal = await denied.call(path, true);
			expect(refusal.status).toBe(403);
			expect(await refusal.json()).toMatchObject({
				error: { code: "remote_control_disabled" },
			});
			expect((await allowed.call(path, true)).status).toBe(200);
		}

		expect(await (await denied.call("/api/capabilities", true)).json()).toEqual(
			{
				fullControl: false,
			},
		);
		expect(
			await (await denied.call("/api/capabilities", false)).json(),
		).toEqual({
			fullControl: true,
		});
		expect(
			await (await allowed.call("/api/capabilities", true)).json(),
		).toEqual({
			fullControl: true,
		});
	});

	test("filters chat events from default remote sockets while local and opted-in sockets receive them", async () => {
		const denied = await harness(false);
		const allowed = await harness(true);
		const remoteDenied = await remoteSocket(denied);
		const local = await localSocket(denied);
		const remoteAllowed = await remoteSocket(allowed);
		const chat: ConsoleEvent = {
			type: "chat",
			chatId: "chat-1",
			event: { type: "message_update" },
		};
		const barrier: ConsoleEvent = { type: "plan", room: "#barrier" };

		// Arm every receiver before either server publishes. The plan frame is a
		// causal barrier: all earlier frames for that socket have been observed.
		const deniedFrames = framesThroughBarrier(remoteDenied);
		const localFrames = framesThroughBarrier(local);
		const allowedFrames = framesThroughBarrier(remoteAllowed);
		denied.api.publish(chat);
		denied.api.publish(barrier);
		allowed.api.publish(chat);
		allowed.api.publish(barrier);

		expect(await deniedFrames).toEqual([barrier]);
		expect(await localFrames).toEqual([chat, barrier]);
		expect(await allowedFrames).toEqual([chat, barrier]);
	});

	test("rejects invalid full-control settings before claiming a daemon pid", async () => {
		for (const env of [
			{ OMA_REMOTE_FULL_CONTROL: "yes" },
			{ OMA_REMOTE_FULL_CONTROL: "1" },
		]) {
			const agentDir = await tempDir();
			await expect(
				bootDaemon({ env, agentDir, projectDir: await tempDir() }),
			).rejects.toThrow(/OMA_REMOTE_FULL_CONTROL/);
			expect(
				await Bun.file(join(agentDir, "oh-my-agent", "daemon.pid")).exists(),
			).toBe(false);
		}
	});
});
