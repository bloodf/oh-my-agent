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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConsoleApi } from "../src/daemon/console-api";
import { startConsoleApi } from "../src/daemon/console-api";
import type { PeerStoreRoots } from "../src/daemon/peer-store";
import { createPeerStore } from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";
import {
	fingerprintPeerDefinition,
	parsePeerDefinition,
} from "../src/shared/agent-definition";
import type { RoomInfo } from "../src/shared/protocol";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOKEN = "operator-token";

/** Records what the supervisor asked the worker to do. */
function stubWorker(name = "reviewer", fingerprint?: string) {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";

	const worker: SupervisedWorker = {
		name,
		fingerprint,
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

/** A definition file the production parser accepts, as the console writes it. */
function peerDocument(name: string, rooms: string[]): string {
	const frontmatter = [
		`name: ${name}`,
		`description: ${name} peer for console management tests.`,
		`spawns: ${JSON.stringify(["scout"])}`,
		...(rooms.length === 0 ? [] : [`rooms: ${JSON.stringify(rooms)}`]),
	].join("\n");
	return `---\n${frontmatter}\n---\nYou are ${name}.\n`;
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

	// The private store the console writes definitions into, and the same
	// store the supervisor re-reads for T-505 staleness — one source of truth,
	// exactly as `src/daemon/main.ts` composes it.
	const roots: PeerStoreRoots = {
		user: join(dir, "user", "agents"),
		project: join(dir, "project", "agents"),
	};
	await mkdir(roots.user, { recursive: true });
	await mkdir(roots.project, { recursive: true });
	const peerStore = createPeerStore(roots);

	/** Rebuilds the supervisor asked for; empty is "no restart happened". */
	const respawns: string[] = [];

	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => Date.now(),
		// Staleness wired on, as the daemon wires it: a membership edit that
		// looked like a policy edit would rebuild here, and the acceptance is
		// that it does not.
		peers: peerStore,
		respawn: async ({ peerName, definition }) => {
			respawns.push(peerName);
			return stubWorker(peerName, fingerprintPeerDefinition(definition)).worker;
		},
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
		peerStore,
		knownRooms,
		ensureRoom,
		token: TOKEN,
		...(options.pollIntervalMs === undefined
			? {}
			: { pollIntervalMs: options.pollIntervalMs }),
	});
	cleanups.push(() => api.close());

	/**
	 * Register a peer with the supervisor and index it as the daemon does,
	 * backed by a real definition file so the staleness check has something to
	 * compare against.
	 */
	const registerPeer = async (
		name: string,
		roomIds: string[],
	): Promise<{ prompts: string[]; state: () => string }> => {
		const path = join(roots.project, `${name}.md`);
		await writeFile(path, peerDocument(name, roomIds), "utf8");
		const definition = parsePeerDefinition(path, await readFile(path, "utf8"));
		const stub = stubWorker(name, fingerprintPeerDefinition(definition));
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
		return { prompts: stub.prompts, state: () => stub.worker.state };
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

	/** Definitions as a cold daemon boot would read them. */
	const reload = () => createPeerStore(roots).list();

	return {
		api,
		rooms,
		roots,
		supervisor,
		peers,
		peerStore,
		respawns,
		knownRooms,
		ensureRoom,
		registerPeer,
		reload,
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
			agents: {
				name: string;
				state: string;
				account: string;
				rooms: string[];
			}[];
		};
		// Membership rides along with status: the console's per-channel toggle
		// has to render the current state, and a second round trip per agent
		// to learn it would be a list the UI could show inconsistently.
		expect(body.agents).toEqual([
			{
				name: "reviewer",
				state: "running",
				account: "acct-1",
				rooms: ["#reviews"],
			},
		]);
	});

	test("an agent's listed rooms follow a membership change", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});

		const res = await h.call("/api/agents");
		const body = (await res.json()) as { agents: { rooms: string[] }[] };
		expect(body.agents[0]?.rooms).toEqual(["#ops", "#reviews"]);
	});

	test("a defined but not-yet-running agent is listed as stopped", async () => {
		const h = await harness();

		await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "researcher",
				description: "Researches things.",
				spawns: ["scout"],
				rooms: ["#research"],
				body: "You are the researcher.",
			}),
		});

		// It has no worker until the next daemon start, and an operator who
		// just created it must still see that it exists.
		const res = await h.call("/api/agents");
		const body = (await res.json()) as {
			agents: {
				name: string;
				state: string;
				account: string;
				rooms: string[];
			}[];
		};
		expect(body.agents).toContainEqual({
			name: "researcher",
			state: "stopped",
			account: "",
			rooms: ["#research"],
		});
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

	test("a posted reply lands in the parent's thread", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root question.",
		});

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Threaded answer.", parentId: root.id }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: {
				id: number;
				parentId: number | null;
				threadRootId: number | null;
			};
		};
		// The whole point of the route: parentage survives the trip through the
		// supervisor into the store, so the reply is in the thread and not a
		// second root beside it.
		expect(body.message.parentId).toBe(root.id);
		expect(body.message.threadRootId).toBe(root.id);
	});

	test("a reply is read back by its own parentage, not by body alone", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root question.",
		});
		// The same words as a root and as a reply: a read-back that matched on
		// author and body alone would hand back whichever landed last.
		await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Same words." }),
		});

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Same words.", parentId: root.id }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: { parentId: number | null; threadRootId: number | null };
		};
		expect(body.message.parentId).toBe(root.id);
		expect(body.message.threadRootId).toBe(root.id);
	});

	test("a parentId in another room is a 400", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.ensureRoom("#ops");
		const elsewhere = await h.rooms.post({
			room: "#ops",
			author: "@you",
			body: "Not this room.",
		});

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Reply.", parentId: elsewhere.id }),
		});

		// The store owns the rule; the route only has to surface its refusal
		// in the store's own words rather than answering 500.
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("invalid_request");
		expect(body.error.message).toContain("MESSAGE_NOT_IN_ROOM");

		// And nothing landed.
		const messages = await h.rooms.listMessages("#reviews", {});
		expect(messages).toHaveLength(0);
	});

	test("an unknown parentId is a 400", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Reply.", parentId: 9999 }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_request");
	});

	test("a malformed parentId is refused before the store sees it", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		for (const parentId of [0, -1, 1.5, "1", true, {}]) {
			const res = await h.call("/api/channels/%23reviews/messages", {
				method: "POST",
				body: JSON.stringify({ body: "Reply.", parentId }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("invalid_request");
		}

		expect(await h.rooms.listMessages("#reviews", {})).toHaveLength(0);
	});

	test("an absent or null parentId posts a root", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "A root.", parentId: null }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: { parentId: number | null };
		};
		expect(body.message.parentId).toBeNull();
	});

	test("a supervisor failure stays a 500, not a caller error", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		// Only the store's parentage rules are the caller's fault. A delivery
		// fault is the daemon's, and reporting it as 400 would tell an
		// operator to fix a message that was never wrong.
		h.supervisor.post = async () => {
			throw new Error("worker socket closed");
		};

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Please review PR 12." }),
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("internal");
		expect(body.error.message).toContain("worker socket closed");
	});

	test("a message that does not land is a 500, not a caller error", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		// A post the supervisor swallows silently leaves the read-back empty.
		// That is a daemon fault too, and the 400 mapping must not absorb it.
		h.supervisor.post = async () => [];

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Please review PR 12." }),
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("internal");
		expect(body.error.message).toContain("did not land");
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

// ── Attribution coercion (ADR-014) ───────────────────────────────────────────

describe("console attribution", () => {
	test("a write claiming a registered peer as author is stored as the human", async () => {
		const h = await harness();
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "reviewer", body: "I approve myself." }),
		});

		// ADR-014: the field stays accepted for compatibility and is ignored,
		// so an old client keeps working and forgery is simply not honored.
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			message: { author: "@you", body: "I approve myself." },
		});

		const messages = await h.rooms.listMessages("#reviews", {});
		expect(messages).toMatchObject([
			{ author: "@you", body: "I approve myself." },
		]);
		// The post still goes through the supervisor, so the peer is woken as
		// the human's message — not silently dropped.
		expect(stub.prompts).toHaveLength(1);
	});

	test("a write claiming an @-namespaced peer as author is stored as the human", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@reviewer", body: "Also me." }),
		});

		expect(res.status).toBe(201);
		expect(await h.rooms.listMessages("#reviews", {})).toMatchObject([
			{ author: "@you", body: "Also me." },
		]);
	});

	test("coercion is universal: an unregistered identity is stored as the human", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		// No peer by this name exists, so an allow-list check would let it
		// through. Attribution is derived server-side, not filtered.
		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@ceo", body: "Ship it." }),
		});

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			message: { author: "@you", body: "Ship it." },
		});
		expect(await h.rooms.listMessages("#reviews", {})).toMatchObject([
			{ author: "@you", body: "Ship it." },
		]);
	});

	test("the human author is accepted", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@you", body: "Human here." }),
		});

		expect(res.status).toBe(201);
		expect(await h.rooms.listMessages("#reviews", {})).toMatchObject([
			{ author: "@you", body: "Human here." },
		]);
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

// ── Reactions ────────────────────────────────────────────────────────────────

describe("reactions", () => {
	test("toggling a reaction on adds it, and toggling again removes it", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "React to me.",
		});

		const on = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});
		expect(on.status).toBe(200);
		expect(await on.json()).toMatchObject({ reacted: true });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "@you", emoji: "👀" },
		]);

		const off = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});
		expect(off.status).toBe(200);
		expect(await off.json()).toMatchObject({ reacted: false });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual(
			[],
		);
	});

	test("a toggle leaves another actor's identical reaction alone", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Two reactors.",
		});
		await h.rooms.react(posted.id, "reviewer", "👀");

		await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});
		await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});

		// Unreact is keyed by (message, actor, emoji): deleting by emoji alone
		// would take the agent's status reaction with it.
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "reviewer", emoji: "👀" },
		]);
	});

	test("a toggle naming a registered peer as actor reacts as the human", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Whose status is this?",
		});

		const res = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ actor: "reviewer", emoji: "👀" }),
		});

		// Reactions carry agent status (ADR-009); a forgeable actor would let
		// the console claim an agent picked work up, so the actor is derived
		// server-side rather than taken from the body (ADR-014).
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ actor: "@you", reacted: true });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "@you", emoji: "👀" },
		]);
	});

	test("reaction coercion is universal: an unregistered actor becomes the human", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Nobody by that name.",
		});

		const res = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ actor: "@ceo", emoji: "👀" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ actor: "@you" });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "@you", emoji: "👀" },
		]);
	});

	test("a toggle on an unknown message is a 404", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/messages/9999/reactions/toggle", {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});

		expect(res.status).toBe(404);
	});

	test("an empty emoji is rejected", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "No emoji.",
		});

		const res = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "  " }),
		});

		expect(res.status).toBe(400);
	});
});

// ── Creating agents ──────────────────────────────────────────────────────────

describe("agent creation", () => {
	test("a created agent lands as a definition file the next boot loads", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "researcher",
				description: "Researches things.",
				spawns: ["scout"],
				rooms: ["#reviews"],
				body: "You are the researcher.",
			}),
		});

		expect(res.status).toBe(201);
		const created = (await res.json()) as {
			agent: { name: string; path: string; rooms: string[] };
		};
		expect(created.agent.name).toBe("researcher");
		expect(created.agent.path).toBe(join(h.roots.project, "researcher.md"));

		// A cold peer store — what the daemon builds on the next start — must
		// see it, or the UI has become a second source of truth.
		const listing = await h.reload();
		expect(listing.errors).toEqual([]);
		const definition = listing.definitions.find((d) => d.name === "researcher");
		expect(definition).toBeDefined();
		expect(definition?.rooms).toEqual(["#reviews"]);
		expect(definition?.body.trim()).toBe("You are the researcher.");
	});

	test("an invalid definition is refused with the parser's own error and writes nothing", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "broken",
				description: "Rooms without a prefix.",
				spawns: ["scout"],
				rooms: ["reviews"],
				body: "You are broken.",
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("invalid_definition");
		// The parser's own words, not a paraphrase: the operator has to be able
		// to act on the same message the daemon would later print.
		expect(body.error.message).toContain('rooms entries must start with "#"');

		await expect(
			readFile(join(h.roots.project, "broken.md"), "utf8"),
		).rejects.toThrow();
		expect((await h.reload()).definitions.map((d) => d.name)).not.toContain(
			"broken",
		);
	});

	test("a created agent's rooms exist and are listed as channels", async () => {
		const h = await harness();

		await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "researcher",
				description: "Researches things.",
				spawns: ["scout"],
				rooms: ["#research"],
				body: "You are the researcher.",
			}),
		});

		const listed = await h.call("/api/channels");
		const body = (await listed.json()) as { channels: RoomInfo[] };
		expect(body.channels.map((c) => c.id)).toContain("#research");
	});

	test("creating an agent that already exists is refused", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "reviewer",
				description: "A second reviewer.",
				spawns: ["scout"],
				body: "You are a different reviewer.",
			}),
		});

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("conflict");
		// The original definition is untouched.
		const listing = await h.reload();
		expect(
			listing.definitions.find((d) => d.name === "reviewer")?.description,
		).toContain("console management tests");
	});
});

// ── Membership ───────────────────────────────────────────────────────────────

describe("membership", () => {
	test("adding a running agent to a channel wakes it on the very next post", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { rooms: string[] }).toMatchObject({
			rooms: ["#ops", "#reviews"],
		});

		// Through the supervisor, which is the only path that proves the live
		// peer's cached room set was updated; RoomStore.post() would pass even
		// with a SQLite-only write.
		await h.supervisor.post({
			room: "#ops",
			author: "@you",
			body: "Ops needs you.",
		});

		expect(peer.prompts.join("\n")).toContain("Ops needs you.");
	});

	test("removing a running agent stops delivery without disturbing other members", async () => {
		const h = await harness();
		const leaving = await h.registerPeer("reviewer", ["#reviews"]);
		const staying = await h.registerPeer("researcher", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/rooms/%23reviews", {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { rooms: string[] }).toMatchObject({
			rooms: [],
		});

		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Still listening?",
		});

		expect(leaving.prompts.join("\n")).not.toContain("Still listening?");
		expect(staying.prompts.join("\n")).toContain("Still listening?");
	});

	test("a removed room's backlog is not delivered when the peer wakes for another reason", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews", "#ops"]);

		await h.call("/api/agents/reviewer/rooms/%23reviews", {
			method: "DELETE",
		});

		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Left channel traffic.",
		});
		// Woken legitimately by a room it is still in. The durable subscription
		// row survives removal (RoomStore has no unsubscribe; T-402 owns it),
		// so a delivery that trusted the database would smuggle the left
		// channel's backlog into this turn.
		await h.supervisor.post({
			room: "#ops",
			author: "@you",
			body: "Ops traffic.",
		});

		expect(peer.prompts.join("\n")).toContain("Ops traffic.");
		expect(peer.prompts.join("\n")).not.toContain("Left channel traffic.");
	});

	test("a membership change is written to the definition as well as the subscription", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});

		// Durable on both sides: the next daemon start reads the file, and a
		// change that lived only in SQLite would be lost by it.
		const listing = await h.reload();
		expect(listing.errors).toEqual([]);
		expect(
			listing.definitions.find((d) => d.name === "reviewer")?.rooms,
		).toEqual(["#ops", "#reviews"]);
	});

	test("membership alone takes effect live and needs no rebuild", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});
		expect((await res.json()) as { rebuildRequired: boolean }).toMatchObject({
			rebuildRequired: false,
		});

		await h.supervisor.post({
			room: "#ops",
			author: "@you",
			body: "No restart needed.",
		});

		// The staleness check re-read the file the console just rewrote and
		// found the same policy, so the live session survived.
		expect(h.respawns).toEqual([]);
		expect(peer.state()).toBe("running");
		expect(peer.prompts.join("\n")).toContain("No restart needed.");
	});

	test("adding an agent to an unknown channel creates it", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#brand-new" }),
		});
		expect(res.status).toBe(200);

		await h.supervisor.post({
			room: "#brand-new",
			author: "@you",
			body: "Fresh channel.",
		});
		expect(peer.prompts.join("\n")).toContain("Fresh channel.");
	});

	test("membership on an unregistered agent is a 404", async () => {
		const h = await harness();
		await h.ensureRoom("#ops");

		const res = await h.call("/api/agents/ghost/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});

		expect(res.status).toBe(404);
	});

	test("an invalid room id is refused and changes nothing", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "ops" }),
		});

		expect(res.status).toBe(400);
		expect(
			(await h.reload()).definitions.find((d) => d.name === "reviewer")?.rooms,
		).toEqual(["#reviews"]);
		expect(peer.state()).toBe("running");
	});
});

// ── Definition edits ─────────────────────────────────────────────────────────

describe("definition edits", () => {
	test("a policy edit is reported as needing a rebuild and is not applied live", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer", {
			method: "PATCH",
			body: JSON.stringify({ body: "You are a much stricter reviewer." }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()) as { rebuildRequired: boolean }).toMatchObject({
			rebuildRequired: true,
		});
		// §10.3: no file mutates under a live worker and no hot reload happens
		// here; the rebuild is the supervisor's, on the next delivered turn.
		expect(h.respawns).toEqual([]);
		expect(peer.state()).toBe("running");

		const listing = await h.reload();
		expect(
			listing.definitions.find((d) => d.name === "reviewer")?.body.trim(),
		).toBe("You are a much stricter reviewer.");
	});

	test("an edit the parser refuses leaves the definition on disk untouched", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		const before = await readFile(join(h.roots.project, "reviewer.md"), "utf8");

		const res = await h.call("/api/agents/reviewer", {
			method: "PATCH",
			body: JSON.stringify({ body: "   " }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_definition");
		expect(await readFile(join(h.roots.project, "reviewer.md"), "utf8")).toBe(
			before,
		);
	});
});
