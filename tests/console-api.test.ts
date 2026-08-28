/**
 * RED tests for src/daemon/console-api.ts
 *
 * Public API under test: startConsoleApi(options) -> ConsoleApi
 *
 * Architecture contract (§4.6, ADR-009). The console API is the browser-facing
 * half of the operator surface. It is deliberately *not* a CRUD layer over
 * SQLite:
 *
 *  - every post goes through `Supervisor.post()`, because the supervisor is
 *    what wakes subscribed peers; a write that stopped at the store would
 *    leave a running agent deaf (ADR-009 consequences);
 *  - the console posts as the human, so a write naming a registered peer as
 *    author is refused — a forgeable author makes a transcript worthless;
 *  - it binds loopback and refuses any request without the operator token, so
 *    a daemon on a shared machine does not hand its rooms to any local
 *    process that guesses the port;
 *  - a WebSocket pushes new messages and reactions, including ones an agent
 *    posted through the control socket rather than through this API.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConsoleApi } from "../src/daemon/console-api";
import { startConsoleApi } from "../src/daemon/console-api";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";
import type { RoomInfo } from "../src/shared/protocol";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOKEN = "operator-token";

/** Records what the supervisor asked the worker to do. */
function stubWorker(name = "reviewer") {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";

	const worker: SupervisedWorker = {
		name,
		get state() {
			return state;
		},
		prompt: async (message) => {
			prompts.push(message);
		},
		park: async () => {
			state = "parked";
		},
		resume: async () => {
			state = "running";
		},
		stop: async () => {
			state = "stopped";
		},
	};

	return { worker, prompts };
}

/**
 * The daemon's composition, minus the process: a real store, a real
 * supervisor, and the same `knownRooms` index and `ensureRoom` closure
 * `src/daemon/main.ts` builds (main.ts:265-270). The console API is handed
 * exactly the slice of `DaemonContext` it is allowed to touch.
 */
async function harness(options: { pollIntervalMs?: number } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-console-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(() => rooms.close());

	const scheduler = new Scheduler({
		now: () => Date.now(),
		setTimer: () => 0,
		clearTimer: () => {},
	});
	scheduler.start();

	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => Date.now(),
	});

	const peers = new Map<string, PeerRecord>();
	const knownRooms = new Map<string, RoomInfo>();
	const ensureRoom = async (id: string): Promise<void> => {
		if (knownRooms.has(id)) return;
		const kind = id.startsWith("@") ? "dm" : "channel";
		await rooms.createRoom({ id, kind });
		knownRooms.set(id, { id, kind, name: id });
	};

	const api: ConsoleApi = await startConsoleApi({
		rooms,
		supervisor,
		peers,
		knownRooms,
		ensureRoom,
		token: TOKEN,
		...(options.pollIntervalMs === undefined
			? {}
			: { pollIntervalMs: options.pollIntervalMs }),
	});
	cleanups.push(() => api.close());

	/** Register a peer with the supervisor and index it as the daemon does. */
	const registerPeer = async (
		name: string,
		roomIds: string[],
	): Promise<{ prompts: string[] }> => {
		const stub = stubWorker(name);
		for (const room of roomIds) await ensureRoom(room);
		await supervisor.register({
			worker: stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: roomIds,
		});
		peers.set(name, {
			worker: stub.worker,
			accountId: "acct-1",
			rooms: roomIds,
		});
		return stub;
	};

	const call = (
		path: string,
		init: RequestInit & { token?: string | null } = {},
	): Promise<Response> => {
		const { token = TOKEN, ...rest } = init;
		const headers = new Headers(rest.headers);
		if (token !== null) headers.set("Authorization", `Bearer ${token}`);
		if (rest.body !== undefined)
			headers.set("Content-Type", "application/json");
		return fetch(`${api.url}${path}`, { ...rest, headers });
	};

	return {
		api,
		rooms,
		supervisor,
		peers,
		knownRooms,
		ensureRoom,
		registerPeer,
		call,
	};
}

/**
 * Resolve with the next parsed frame, or reject if none arrives in time.
 *
 * The timer is a failure bound, not a wait: every passing path resolves on the
 * real `message` event the moment it lands, so the suite pays the timeout only
 * when the assertion is "no frame arrives" or the code under test is broken.
 */
function nextFrame(socket: WebSocket, timeoutMs = 2_000): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const onMessage = (event: MessageEvent) => {
		clearTimeout(timer);
		socket.removeEventListener("message", onMessage);
		resolve(JSON.parse(String(event.data)));
	};
	const timer = setTimeout(() => {
		socket.removeEventListener("message", onMessage);
		reject(new Error("no websocket frame within timeout"));
	}, timeoutMs);
	socket.addEventListener("message", onMessage);
	return promise;
}

/** Resolve on the socket's own `open` event; the timer only bounds failure. */
function opened(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(
		() => reject(new Error("websocket did not open")),
		timeoutMs,
	);
	socket.addEventListener("open", () => {
		clearTimeout(timer);
		resolve();
	});
	socket.addEventListener("error", () => {
		clearTimeout(timer);
		reject(new Error("websocket errored"));
	});
	return promise;
}

// ── Operator token ───────────────────────────────────────────────────────────

describe("operator token", () => {
	test("binds loopback by default", async () => {
		const h = await harness();
		// A console reachable from the network would hand every room to anyone
		// who can route to the host; §4.6 keeps it beside the unix socket.
		expect(h.api.hostname).toBe("127.0.0.1");
		expect(h.api.url).toContain("127.0.0.1");
	});

	test("refuses a request with no operator token", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", { token: null });

		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("unauthorized");
	});

	test("refuses a request with the wrong operator token", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", { token: "not-the-token" });

		expect(res.status).toBe(401);
	});

	test("refuses a token that is a prefix of the real one", async () => {
		const h = await harness();

		// A length-only or prefix comparison would let this through.
		const res = await h.call("/api/agents", {
			token: TOKEN.slice(0, TOKEN.length - 1),
		});

		expect(res.status).toBe(401);
	});

	test("accepts the operator token", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			agents: { name: string; state: string; account: string }[];
		};
		expect(body.agents).toEqual([
			{ name: "reviewer", state: "running", account: "acct-1" },
		]);
	});

	test("refuses a websocket with no operator token", async () => {
		const h = await harness();
		const url = `${h.api.url.replace("http://", "ws://")}/api/events`;

		const socket = new WebSocket(url);
		const closed = new Promise<number>((resolve) => {
			socket.addEventListener("close", (event) => resolve(event.code));
			socket.addEventListener("error", () => resolve(-1));
		});

		await expect(opened(socket, 500)).rejects.toThrow();
		expect(await closed).not.toBe(1000);
		socket.close();
	});
});

// ── Channels ─────────────────────────────────────────────────────────────────

describe("channels", () => {
	test("creating a channel over HTTP makes it visible in the list", async () => {
		const h = await harness();

		const created = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "#reviews" }),
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({
			channel: { id: "#reviews", kind: "channel", name: "#reviews" },
		});

		const listed = await h.call("/api/channels");
		const body = (await listed.json()) as { channels: RoomInfo[] };
		expect(body.channels).toContainEqual({
			id: "#reviews",
			kind: "channel",
			name: "#reviews",
		});
	});

	test("a channel created over HTTP is visible to a worker", async () => {
		const h = await harness();

		await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "#reviews" }),
		});
		// Registering after the fact must find the room already there: the
		// supervisor subscribes the peer to a room the console created.
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Look at this.",
		});

		expect(stub.prompts).toHaveLength(1);
		expect(stub.prompts[0]).toContain("Look at this.");
	});

	test("a DM id is created as a dm, not a channel", async () => {
		const h = await harness();

		const created = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "@reviewer" }),
		});

		expect(await created.json()).toEqual({
			channel: { id: "@reviewer", kind: "dm", name: "@reviewer" },
		});
	});

	test("an empty channel id is rejected", async () => {
		const h = await harness();

		const res = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "  " }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_request");
	});
});

// ── Messages ─────────────────────────────────────────────────────────────────

describe("messages", () => {
	test("posting over HTTP wakes a subscribed peer", async () => {
		const h = await harness();
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Please review PR 12." }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: { id: number; author: string; body: string };
		};
		expect(body.message.author).toBe("@you");
		expect(body.message.body).toBe("Please review PR 12.");

		// The acceptance-critical bit: a write that stopped at RoomStore.post
		// would leave this empty, and the agent would never notice.
		expect(stub.prompts).toHaveLength(1);
		expect(stub.prompts[0]).toContain("Please review PR 12.");
	});

	test("messages carry the store's thread and reaction fields", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root.",
		});
		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Reply.",
			parentId: root.id,
		});
		await h.rooms.react(root.id, "reviewer", "👀");

		const res = await h.call("/api/channels/%23reviews/messages");
		const body = (await res.json()) as {
			messages: {
				id: number;
				parentId: number | null;
				threadRootId: number | null;
				replyCount: number;
				reactions: { actor: string; emoji: string }[];
			}[];
		};

		expect(body.messages).toHaveLength(2);
		expect(body.messages[0]).toMatchObject({
			id: root.id,
			parentId: null,
			replyCount: 1,
			reactions: [{ actor: "reviewer", emoji: "👀" }],
		});
		expect(body.messages[1]).toMatchObject({
			parentId: root.id,
			threadRootId: root.id,
		});
	});

	test("messages paginate with afterId and limit", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const first = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "One.",
		});
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Two." });
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Three." });

		const res = await h.call(
			`/api/channels/%23reviews/messages?afterId=${first.id}&limit=1`,
		);
		const body = (await res.json()) as { messages: { body: string }[] };

		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]?.body).toBe("Two.");
	});

	test("reading an unknown channel is a 404", async () => {
		const h = await harness();

		const res = await h.call("/api/channels/%23nope/messages");

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("an empty message body is rejected", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "   " }),
		});

		expect(res.status).toBe(400);
	});
});

// ── Author forgery ───────────────────────────────────────────────────────────

describe("agent-authored writes", () => {
	test("a write claiming a registered peer as author is refused", async () => {
		const h = await harness();
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "reviewer", body: "I approve myself." }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("forbidden_author");

		// Refused means refused: nothing landed, and nobody was woken.
		const messages = await h.rooms.listMessages("#reviews", {});
		expect(messages).toHaveLength(0);
		expect(stub.prompts).toHaveLength(0);
	});

	test("a write claiming an @-namespaced peer as author is refused", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@reviewer", body: "Also me." }),
		});

		expect(res.status).toBe(403);
	});

	test("the human author is accepted", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@you", body: "Human here." }),
		});

		expect(res.status).toBe(201);
	});
});

// ── Live updates ─────────────────────────────────────────────────────────────

describe("websocket", () => {
	test("a connected websocket receives a message posted by an agent", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const frame = nextFrame(socket);
		// Posted through the supervisor, exactly as the control socket does for
		// an agent's `chat_send` — not through this API.
		await h.supervisor.post({
			room: "#reviews",
			author: "reviewer",
			body: "Review done.",
		});

		expect(await frame).toMatchObject({
			type: "message",
			message: {
				room: "#reviews",
				author: "reviewer",
				body: "Review done.",
			},
		});
	});

	test("a connected websocket receives a reaction", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Pick this up.",
		});

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const frame = nextFrame(socket);
		await h.rooms.react(posted.id, "reviewer", "👀");

		expect(await frame).toEqual({
			type: "reaction",
			room: "#reviews",
			messageId: posted.id,
			actor: "reviewer",
			emoji: "👀",
		});
	});

	test("a websocket does not replay the backlog on connect", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Old." });

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		// A client that had to filter history would show every old message as
		// new on every reconnect.
		await expect(nextFrame(socket, 120)).rejects.toThrow();
	});

	test("a websocket accepts the token as a query parameter", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");

		// A browser cannot set Authorization on a WebSocket handshake.
		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events?token=${TOKEN}`,
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const frame = nextFrame(socket);
		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Anyone?",
		});

		expect(await frame).toMatchObject({
			type: "message",
			message: { body: "Anyone?" },
		});
	});
});
