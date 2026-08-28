/**
 * Purpose: The browser-facing half of the operator surface (§4.6). Serves the
 * console's reads (agents, channels, messages) and writes (create a channel,
 * post a message) over loopback HTTP, and pushes new messages and reactions
 * over a WebSocket so an open console does not poll.
 *
 * Public API: `startConsoleApi`, `ConsoleApi`, `StartConsoleApiOptions`,
 * `ConsoleEvent`.
 *
 * Upstream deps: `../rooms/store` (durable rooms, threads, reactions),
 * `./supervisor` (the seam that wakes peers), `./socket` (`HUMAN_AUTHOR`,
 * `PeerRecord`), `../shared/protocol` (`RoomInfo`, `AgentStatus`).
 *
 * Downstream consumers: the daemon entry point, which owns the operator token
 * and this server's lifetime, and the browser client (T-603).
 *
 * Failure modes: a request without the operator token is refused 401 before
 * anything else runs, including the WebSocket handshake. A write naming a
 * registered peer as its author is refused 403 and lands nothing — the console
 * posts as the human, and a forgeable author makes a transcript worthless.
 * Errors are `{error: {code, message}}` throughout.
 *
 * Performance: reads are one store query each. The live feed polls only while
 * at least one WebSocket is connected, one query per known room per tick, and
 * reaction diffing is bounded to the most recent `REACTION_WINDOW` messages
 * per room.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { RoomMessage, RoomStore } from "../rooms/store";
import type { AgentStatus, RoomInfo } from "../shared/protocol";
import { HUMAN_AUTHOR, type PeerRecord } from "./socket";
import type { Supervisor } from "./supervisor";

/** Loopback: a console reachable from the network is a rooms leak. */
const DEFAULT_HOSTNAME = "127.0.0.1";

/** How often the live feed re-reads rooms while a console is connected. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * How far back a tick looks for reaction changes, in message ids per room.
 * Reactions carry agent status (ADR-009), which is only interesting on recent
 * traffic; without a bound, every tick would re-read a room's whole history.
 */
const REACTION_WINDOW = 200;

/** A frame pushed to a connected console. */
export type ConsoleEvent =
	| { type: "message"; message: RoomMessage }
	| {
			type: "reaction";
			room: string;
			messageId: number;
			actor: string;
			emoji: string;
	  };

export interface StartConsoleApiOptions {
	rooms: RoomStore;
	/** Every post goes through this; writing to the store leaves peers deaf. */
	supervisor: Supervisor;
	/** Registered peers by name, so an agent-authored write can be refused. */
	peers: Map<string, PeerRecord>;
	/** Rooms the daemon knows about; the store does not enumerate them. */
	knownRooms: Map<string, RoomInfo>;
	/** Create the room if it does not exist yet, and index it. */
	ensureRoom(id: string): Promise<void>;
	/** Operator token. Generation and storage are the daemon's concern. */
	token: string;
	hostname?: string;
	/** `0` lets the OS pick, which is what the daemon and tests both want. */
	port?: number;
	pollIntervalMs?: number;
}

export interface ConsoleApi {
	url: string;
	hostname: string;
	port: number;
	close(): Promise<void>;
}

/** Attached to an upgraded socket; the token was checked at the handshake. */
interface SocketData {
	id: number;
}

/** What one room looked like at the last tick. */
interface RoomCursor {
	/** Highest message id already broadcast. */
	lastMessageId: number;
	/** `${messageId}:${actor}:${emoji}` already broadcast, within the window. */
	reactions: Set<string>;
}

/**
 * Compare over digests rather than raw bytes: `timingSafeEqual` throws on a
 * length mismatch, and branching on length first would leak the token's size.
 * Hashing makes both operands 32 bytes whatever the input.
 */
function tokenMatches(presented: string, expected: string): boolean {
	const left = createHash("sha256").update(presented).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}

export async function startConsoleApi(
	options: StartConsoleApiOptions,
): Promise<ConsoleApi> {
	const { rooms, supervisor, peers, knownRooms, ensureRoom, token } = options;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const hostname = options.hostname ?? DEFAULT_HOSTNAME;

	const json = (status: number, body: unknown): Response =>
		Response.json(body, { status });

	const fail = (status: number, code: string, message: string): Response =>
		Response.json({ error: { code, message } }, { status });

	/**
	 * The presented operator token, from the header a client can set or the
	 * query parameter a browser WebSocket handshake is stuck with.
	 */
	const presentedToken = (
		request: Request,
		url: URL,
		allowQuery: boolean,
	): string | undefined => {
		const header = request.headers.get("Authorization");
		if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
		// The query parameter exists for the WebSocket handshake, the one place
		// a browser cannot set headers; honoring it elsewhere would plant the
		// token in browser history.
		if (!allowQuery) return undefined;
		return url.searchParams.get("token") ?? undefined;
	};

	// ── Live feed ─────────────────────────────────────────────────────────────

	const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
	const cursors = new Map<string, RoomCursor>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let polling = false;
	let nextSocketId = 1;

	const broadcast = (event: ConsoleEvent): void => {
		const frame = JSON.stringify(event);
		for (const socket of sockets) socket.send(frame);
	};

	/**
	 * Read one room and emit whatever is new since the last tick.
	 *
	 * `afterId` starts at the reaction floor rather than the message cursor so
	 * a reaction landing on an already-broadcast message is still seen; the
	 * message cursor is what decides which of those rows are *new messages*.
	 */
	const pollRoom = async (
		roomId: string,
		cursor: RoomCursor,
	): Promise<void> => {
		const floor = Math.max(0, cursor.lastMessageId - REACTION_WINDOW);
		let messages: RoomMessage[];
		try {
			messages = await rooms.listMessages(roomId, { afterId: floor });
		} catch {
			// A room indexed but not yet in the store, or removed underneath us:
			// the next tick retries, and a dead feed helps nobody.
			return;
		}

		const seen = new Set<string>();
		for (const message of messages) {
			if (message.id > cursor.lastMessageId) {
				cursor.lastMessageId = message.id;
				broadcast({ type: "message", message });
			}
			for (const reaction of message.reactions) {
				const key = `${message.id}:${reaction.actor}:${reaction.emoji}`;
				seen.add(key);
				if (cursor.reactions.has(key)) continue;
				broadcast({
					type: "reaction",
					room: roomId,
					messageId: message.id,
					actor: reaction.actor,
					emoji: reaction.emoji,
				});
			}
		}
		// Keep only keys still inside the window, so a long-lived console does
		// not accumulate a key per reaction ever made.
		cursor.reactions = seen;
	};

	const tick = async (): Promise<void> => {
		for (const roomId of knownRooms.keys()) {
			let cursor = cursors.get(roomId);
			if (!cursor) {
				// A room that appeared after the feed started is new, so its
				// messages are new too: start at zero rather than at its head.
				cursor = { lastMessageId: 0, reactions: new Set() };
				cursors.set(roomId, cursor);
			}
			await pollRoom(roomId, cursor);
		}
	};

	/**
	 * Snapshot every known room at its head, so a console that just connected
	 * is not handed the backlog as if it were live.
	 */
	const primeCursors = async (): Promise<void> => {
		cursors.clear();
		for (const roomId of knownRooms.keys()) {
			const cursor: RoomCursor = { lastMessageId: 0, reactions: new Set() };
			try {
				const messages = await rooms.listMessages(roomId, {});
				cursor.lastMessageId = messages.at(-1)?.id ?? 0;
				const floor = Math.max(0, cursor.lastMessageId - REACTION_WINDOW);
				for (const message of messages) {
					if (message.id <= floor) continue;
					for (const reaction of message.reactions) {
						cursor.reactions.add(
							`${message.id}:${reaction.actor}:${reaction.emoji}`,
						);
					}
				}
			} catch {
				// Indexed but unreadable; the first tick will catch up.
			}
			cursors.set(roomId, cursor);
		}
	};

	/**
	 * Poll rather than subscribe.
	 *
	 * There is no notification seam to hook: `Supervisor.post()` returns the
	 * peers it woke but emits no event, and `RoomStore.react()` is a bare
	 * insert. Both are owned by other tasks, and an agent posting through the
	 * control socket holds its own reference to them — so wrapping the
	 * instances handed to this module would miss exactly the traffic the
	 * console most needs to see (an agent's reply). Polling reads the same
	 * durable state whatever wrote it. It runs only while a console is
	 * connected, so an unattended daemon does no work for it.
	 */
	const startPolling = async (): Promise<void> => {
		if (polling) return;
		// Claim before the first await: a second socket connecting during
		// primeCursors() must not start a second interval — the first handle
		// would be overwritten and could never be cleared.
		polling = true;
		await primeCursors();
		// Every console may have disconnected while priming; leave nothing
		// running for zero listeners.
		if (!polling) return;
		let running = false;
		poller = setInterval(() => {
			// Skip rather than overlap: a slow tick must not queue more of itself.
			if (running) return;
			running = true;
			void tick().finally(() => {
				running = false;
			});
		}, pollIntervalMs);
	};

	const stopPolling = (): void => {
		if (!polling) return;
		polling = false;
		if (poller !== undefined) {
			clearInterval(poller);
			poller = undefined;
		}
		cursors.clear();
	};

	// ── Writes ────────────────────────────────────────────────────────────────

	/**
	 * Whether this author names an agent. Both the bare peer name and the
	 * `@`-namespaced form are refused; `@you` is the human and is not a peer.
	 */
	const namesAgent = (author: string): boolean => {
		const bare = author.replace(/^@+/, "").toLowerCase();
		for (const name of peers.keys()) {
			if (name.toLowerCase() === bare) return true;
		}
		return false;
	};

	/**
	 * Post through the supervisor — which is what wakes subscribed peers — then
	 * read our own message back so the caller gets its id and thread fields.
	 */
	const post = async (
		roomId: string,
		author: string,
		body: string,
	): Promise<RoomMessage> => {
		const before = (await rooms.listMessages(roomId, {})).at(-1)?.id ?? 0;
		await supervisor.post({ room: roomId, author, body });
		const landed = (await rooms.listMessages(roomId, { afterId: before }))
			.filter((message) => message.author === author && message.body === body)
			.at(-1);
		if (!landed) throw new Error(`Post to ${roomId} did not land`);
		return landed;
	};

	// ── Routes ────────────────────────────────────────────────────────────────

	const handle = async (request: Request, url: URL): Promise<Response> => {
		const path = url.pathname;

		if (path === "/api/agents") {
			if (request.method !== "GET") {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}
			const agents: AgentStatus[] = [...peers].map(([name, record]) => ({
				name,
				state: record.worker.state,
				account: record.accountId,
				...(record.model === undefined ? {} : { model: record.model }),
			}));
			return json(200, { agents });
		}

		if (path === "/api/channels") {
			if (request.method === "GET") {
				return json(200, { channels: [...knownRooms.values()] });
			}
			if (request.method === "POST") {
				let payload: unknown;
				try {
					payload = await request.json();
				} catch {
					return fail(400, "invalid_request", "Body is not valid JSON");
				}
				const id =
					typeof payload === "object" &&
					payload !== null &&
					"id" in payload &&
					typeof payload.id === "string"
						? payload.id.trim()
						: "";
				if (id.length === 0) {
					return fail(400, "invalid_request", "Channel id is required");
				}
				await ensureRoom(id);
				const channel = knownRooms.get(id);
				if (!channel) {
					return fail(500, "internal", `Channel ${id} was not indexed`);
				}
				return json(201, { channel });
			}
			return fail(405, "method_not_allowed", `${request.method} not allowed`);
		}

		const messagesRoute = /^\/api\/channels\/([^/]+)\/messages$/.exec(path);
		if (messagesRoute?.[1] !== undefined) {
			const roomId = decodeURIComponent(messagesRoute[1]);
			if (!knownRooms.has(roomId)) {
				return fail(404, "not_found", `Unknown channel: ${roomId}`);
			}

			if (request.method === "GET") {
				const rawAfter = url.searchParams.get("afterId");
				const rawLimit = url.searchParams.get("limit");
				const opts: { afterId?: number; limit?: number } = {};
				if (rawAfter !== null) {
					const afterId = Number(rawAfter);
					if (!Number.isInteger(afterId) || afterId < 0) {
						return fail(400, "invalid_request", "afterId must be an integer");
					}
					opts.afterId = afterId;
				}
				if (rawLimit !== null) {
					const limit = Number(rawLimit);
					if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
						return fail(400, "invalid_request", "limit must be 1..500");
					}
					opts.limit = limit;
				}
				return json(200, { messages: await rooms.listMessages(roomId, opts) });
			}

			if (request.method === "POST") {
				let payload: unknown;
				try {
					payload = await request.json();
				} catch {
					return fail(400, "invalid_request", "Body is not valid JSON");
				}
				const fields =
					typeof payload === "object" && payload !== null
						? (payload as { body?: unknown; author?: unknown })
						: {};
				const body = typeof fields.body === "string" ? fields.body.trim() : "";
				if (body.length === 0) {
					return fail(400, "invalid_request", "Message body is required");
				}
				const author =
					typeof fields.author === "string" && fields.author.trim().length > 0
						? fields.author.trim()
						: HUMAN_AUTHOR;
				if (namesAgent(author)) {
					return fail(
						403,
						"forbidden_author",
						`The console posts as the human; ${author} is an agent`,
					);
				}
				return json(201, { message: await post(roomId, author, body) });
			}

			return fail(405, "method_not_allowed", `${request.method} not allowed`);
		}

		return fail(404, "not_found", `Unknown route: ${path}`);
	};

	const server = Bun.serve<SocketData>({
		hostname,
		port: options.port ?? 0,
		// A console sits open with nothing to say for minutes at a time; the
		// default idle timeout would sever its live feed.
		idleTimeout: 0,
		fetch: async (request, self): Promise<Response | undefined> => {
			const url = new URL(request.url);
			const isUpgrade = url.pathname === "/api/events";
			const presented = presentedToken(request, url, isUpgrade);
			if (presented === undefined || !tokenMatches(presented, token)) {
				return fail(401, "unauthorized", "Operator token required");
			}

			if (url.pathname === "/api/events") {
				const upgraded = self.upgrade(request, {
					data: { id: nextSocketId++ },
				});
				if (upgraded) return undefined;
				return fail(400, "invalid_request", "WebSocket upgrade failed");
			}

			try {
				return await handle(request, url);
			} catch (error) {
				return fail(
					500,
					"internal",
					error instanceof Error ? error.message : String(error),
				);
			}
		},
		websocket: {
			open: (socket) => {
				sockets.add(socket);
				void startPolling();
			},
			message: () => {
				// The console reads over the socket and writes over HTTP, so an
				// inbound frame carries nothing this server acts on.
			},
			close: (socket) => {
				sockets.delete(socket);
				if (sockets.size === 0) stopPolling();
			},
		},
	});

	// A TCP listener always resolves both, but the type admits `undefined` for
	// the unix variant. Fail loudly rather than publish a half-formed url.
	const boundHost = server.hostname;
	const boundPort = server.port;
	if (boundHost === undefined || boundPort === undefined) {
		await server.stop(true);
		throw new Error("Console API did not bind a host and port");
	}

	let closed = false;
	return {
		url: `http://${boundHost}:${boundPort}`,
		hostname: boundHost,
		port: boundPort,
		close: async () => {
			if (closed) return;
			closed = true;
			// Stop the feed first: an in-flight tick holds no request, but it
			// would keep querying a store the daemon is about to close.
			stopPolling();
			// `server.stop(true)` severs connected websockets on its own, and the
			// client observes the close. Calling `socket.close()` first instead
			// deadlocks `stop(true)` on Bun 1.3.14 — verified: a server-side
			// close followed by `stop(true)` never resolves, while `stop(true)`
			// alone resolves immediately and the client still sees its close
			// event.
			sockets.clear();
			await server.stop(true);
		},
	};
}
