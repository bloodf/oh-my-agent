/**
 * Purpose: The browser-facing half of the operator surface (§4.6). Serves the
 * console client itself from `src/console/`, plus the reads (agents, channels,
 * messages) and writes (create an agent or channel, edit a definition, change
 * membership, post a message, toggle a reaction) behind it over loopback HTTP,
 * and pushes new messages and reactions over a WebSocket so an open console
 * does not poll.
 *
 * Public API: `startConsoleApi`, `ConsoleApi`, `StartConsoleApiOptions`,
 * `ConsoleEvent`.
 *
 * Upstream deps: `../rooms/store` (durable rooms, threads, reactions),
 * `./supervisor` (the seam that wakes peers, and the sole writer of a live
 * peer's cached room set), `./peer-store` (definitions on disk), `./socket`
 * (`HUMAN_AUTHOR`, `PeerRecord`), `../shared/protocol` (`RoomInfo`,
 * `AgentStatus`), `../shared/agent-definition` (`fingerprintPeerDefinition`).
 *
 * Downstream consumers: the daemon entry point, which owns the operator token
 * and this server's lifetime, and the browser client (T-603, T-605).
 *
 * Failure modes: a request without the operator token is refused 401 before
 * anything else runs — the client's own HTML included, so a shell handed out
 * unauthenticated cannot become a fingerprinting oracle for a running daemon —
 * and that check precedes the WebSocket handshake too. Static paths are an
 * allow-list resolved and contained under `src/console/`, so no request target
 * reaches a file beside it. A write naming a registered peer as its author — or
 * as a reaction's actor, since reactions carry agent status — is refused 403 and
 * lands nothing: the console acts as the human, and a forgeable identity makes a
 * transcript worthless. A definition the parser refuses is answered 400 with the
 * parser's own message and no file is written. Errors are
 * `{error: {code, message}}` throughout.
 *
 * Performance: reads are one store query each. A definition write is one
 * render, one parse, and one atomic rename. The live feed polls only while at
 * least one WebSocket is connected, one query per known room per tick, and
 * reaction diffing is bounded to the most recent `REACTION_WINDOW` messages
 * per room.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { join, resolve, sep } from "node:path";

import type { RoomMessage, RoomStore } from "../rooms/store";
import {
	fingerprintPeerDefinition,
	type PeerDefinition,
} from "../shared/agent-definition";
import type { AgentStatus, RoomInfo } from "../shared/protocol";
import type { PeerDefinitionFields, PeerStore } from "./peer-store";
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
	/**
	 * Definitions on disk. A peer created or edited here becomes a file in the
	 * private store, so the UI and a hand-written definition produce the same
	 * thing and neither becomes a second source of truth.
	 */
	peerStore: PeerStore;
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
	const { rooms, supervisor, peers, peerStore, knownRooms, ensureRoom, token } =
		options;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const hostname = options.hostname ?? DEFAULT_HOSTNAME;

	const json = (status: number, body: unknown): Response =>
		Response.json(body, { status });

	const fail = (status: number, code: string, message: string): Response =>
		Response.json({ error: { code, message } }, { status });

	/**
	 * The presented operator token, from a header a client can set or the query
	 * parameter a browser is stuck with on a handshake or a sub-resource load.
	 */
	const presentedToken = (
		request: Request,
		url: URL,
		allowQuery: boolean,
	): string | undefined => {
		const header = request.headers.get("Authorization");
		if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
		// What the browser client sends on every API call (`app.js:177`). The
		// header is the client's own choice, not a browser constraint — a
		// same-origin fetch could set `Authorization` — but it is what ships, so
		// refusing it here is a console whose every request 401s.
		const operator = request.headers.get("X-Operator-Token");
		if (operator !== null && operator.length > 0) return operator;
		// The query parameter exists for the WebSocket handshake and the static
		// client, the two places a browser cannot set a header at all; honoring
		// it on an API call would plant the token in browser history.
		if (!allowQuery) return undefined;
		return url.searchParams.get("token") ?? undefined;
	};

	// ── Live feed ─────────────────────────────────────────────────────────────

	const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
	const cursors = new Map<string, RoomCursor>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let polling = false;
	let tickInFlight: Promise<void> | undefined;
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
			tickInFlight = tick()
				.catch(() => {})
				.finally(() => {
					running = false;
					tickInFlight = undefined;
				});
		}, pollIntervalMs);
	};

	const stopPolling = async (): Promise<void> => {
		if (!polling) return;
		polling = false;
		if (poller !== undefined) {
			clearInterval(poller);
			poller = undefined;
		}
		// A tick already in flight holds a store read; it must finish before the
		// store closes under it, not after.
		await tickInFlight;
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

	/**
	 * Locate a message by id across known rooms.
	 *
	 * The store has no point lookup and reactions are addressed by message id
	 * alone, so the room has to be recovered before anything can be checked
	 * against it.
	 */
	const findMessage = async (
		messageId: number,
	): Promise<RoomMessage | undefined> => {
		for (const roomId of knownRooms.keys()) {
			const found = (await rooms.listMessages(roomId, {})).find(
				(message) => message.id === messageId,
			);
			if (found) return found;
		}
		return undefined;
	};

	/** JSON body, or `undefined` when it is not an object. */
	const readBody = async (
		request: Request,
	): Promise<Record<string, unknown> | undefined> => {
		try {
			const payload: unknown = await request.json();
			if (typeof payload !== "object" || payload === null) return undefined;
			return payload as Record<string, unknown>;
		} catch {
			return undefined;
		}
	};

	/**
	 * A room id is `#channel` or `@dm`; the parser enforces the same rule on a
	 * definition, so accepting a bare name here would write a file the daemon
	 * refuses on its next boot.
	 */
	const roomIdFrom = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const room = value.trim();
		if (room.length < 2) return undefined;
		if (!room.startsWith("#") && !room.startsWith("@")) return undefined;
		return room;
	};

	/** The definition's fields, ready to be rewritten with an override. */
	const fieldsOf = (definition: PeerDefinition): PeerDefinitionFields => {
		const { sha256: _sha, filePath: _path, ...fields } = definition;
		return fields;
	};

	/**
	 * Write a definition and report whether the change needs a rebuild.
	 *
	 * Membership is excluded from the comparison deliberately: `resubscribe`
	 * applies rooms to the live peer, so a rooms-only edit is live at once,
	 * while any other field is policy the running worker was materialized
	 * from. The supervisor performs the rebuild itself on the next delivered
	 * turn (§10.3); nothing here touches a live worker.
	 */
	const writeDefinition = async (
		fields: PeerDefinitionFields,
		previous?: PeerDefinition,
	): Promise<{ definition: PeerDefinition; rebuildRequired: boolean }> => {
		// The membership/edit path always targets an existing file; only the
		// creation route asks for overwrite protection.
		const definition = await peerStore.write(fields, { overwrite: true });
		if (!previous) return { definition, rebuildRequired: false };
		const policyOnly = fingerprintPeerDefinition({
			...definition,
			rooms: previous.rooms,
		});
		return {
			definition,
			rebuildRequired: policyOnly !== fingerprintPeerDefinition(previous),
		};
	};

	/**
	 * Apply a definition's rooms to the running peer.
	 *
	 * Through the supervisor's single operation rather than by touching its
	 * cached set: two writers to that set is exactly the defect this task
	 * exists to avoid (ADR-009).
	 */
	const applyMembership = async (peerName: string): Promise<string[]> => {
		const definition = await peerStore.get(peerName);
		for (const room of definition?.rooms ?? []) await ensureRoom(room);
		const applied = await supervisor.resubscribe(peerName);
		// The daemon's own peer index backs status reads; leaving it stale
		// would make the console disagree with itself about membership.
		const record = peers.get(peerName);
		if (record) peers.set(peerName, { ...record, rooms: applied });
		return applied;
	};

	// ── Routes ────────────────────────────────────────────────────────────────

	const handle = async (request: Request, url: URL): Promise<Response> => {
		const path = url.pathname;

		if (path === "/api/agents") {
			if (request.method === "GET") {
				const agents: (AgentStatus & { rooms: string[] })[] = [...peers].map(
					([name, record]) => ({
						name,
						state: record.worker.state,
						account: record.accountId,
						...(record.model === undefined ? {} : { model: record.model }),
						// Membership rides along with status so the console's
						// per-channel toggle renders from one read.
						rooms: [...record.rooms],
					}),
				);
				// A definition with no worker is an agent that starts on the next
				// daemon start. Omitting it would make an agent the operator just
				// created vanish from the UI that created it.
				const { definitions } = await peerStore.list();
				for (const definition of definitions) {
					if (peers.has(definition.name)) continue;
					agents.push({
						name: definition.name,
						state: "stopped",
						account: "",
						rooms: definition.rooms ?? [],
					});
				}
				return json(200, { agents });
			}

			if (request.method === "POST") {
				const payload = await readBody(request);
				if (!payload) {
					return fail(400, "invalid_request", "Body is not valid JSON");
				}
				const name =
					typeof payload.name === "string" ? payload.name.trim() : "";
				if (name.length === 0) {
					return fail(400, "invalid_request", "Agent name is required");
				}
				if (await peerStore.get(name)) {
					return fail(409, "conflict", `Agent ${name} already exists`);
				}

				const { name: _name, ...rest } = payload;
				let created: PeerDefinition;
				try {
					// The parser is the gate: `write` renders, parses, and only
					// then lands the file, so an invalid definition is refused
					// in the operator's own words and nothing reaches disk.
					created = await peerStore.write(
						{
							...(rest as Omit<PeerDefinitionFields, "name" | "body">),
							name,
							body: typeof payload.body === "string" ? payload.body : "",
						},
						{ overwrite: false },
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (message.startsWith("PEER_EXISTS")) {
						return fail(409, "conflict", `Agent ${name} already exists`);
					}
					if (message.startsWith("INVALID_NAME")) {
						return fail(400, "invalid_request", message);
					}
					return fail(400, "invalid_definition", message);
				}

				// A peer's declared rooms exist from the moment it does, exactly
				// as `Supervisor.register` guarantees for a peer loaded at boot.
				for (const room of created.rooms ?? []) await ensureRoom(room);

				return json(201, {
					agent: {
						name: created.name,
						path: created.filePath ?? "",
						rooms: created.rooms ?? [],
					},
					// A new agent is not a running one: it starts on the next
					// daemon start, and saying so is step 7 of the contract.
					rebuildRequired: true,
				});
			}

			return fail(405, "method_not_allowed", `${request.method} not allowed`);
		}

		const membershipRoute =
			/^\/api\/agents\/([^/]+)\/rooms(?:\/([^/]+))?$/.exec(path);
		if (membershipRoute?.[1] !== undefined) {
			const peerName = decodeURIComponent(membershipRoute[1]);
			const definition = await peerStore.get(peerName);
			if (!definition || !peers.has(peerName)) {
				return fail(404, "not_found", `Unknown agent: ${peerName}`);
			}

			let room: string | undefined;
			let next: string[];
			if (request.method === "POST") {
				const payload = await readBody(request);
				if (!payload) {
					return fail(400, "invalid_request", "Body is not valid JSON");
				}
				room = roomIdFrom(payload.room);
				if (room === undefined) {
					return fail(
						400,
						"invalid_request",
						'A room id starting with "#" or "@" is required',
					);
				}
				next = [...new Set([...(definition.rooms ?? []), room])].sort();
			} else if (request.method === "DELETE") {
				room = membershipRoute[2] && decodeURIComponent(membershipRoute[2]);
				if (!room) {
					return fail(400, "invalid_request", "A room id is required");
				}
				next = (definition.rooms ?? []).filter((entry) => entry !== room);
			} else {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}

			if (request.method === "POST" && room !== undefined) {
				await ensureRoom(room);
			}

			try {
				await writeDefinition(
					{
						...fieldsOf(definition),
						// An empty list is dropped rather than written: the parser
						// refuses `rooms: []`, and a peer in no rooms is a peer
						// with no `rooms:` key.
						...(next.length === 0 ? { rooms: undefined } : { rooms: next }),
					},
					definition,
				);
			} catch (error) {
				return fail(
					400,
					"invalid_definition",
					error instanceof Error ? error.message : String(error),
				);
			}

			// Disk is not enough: the live peer's cached room set decides who
			// `Supervisor.post()` wakes, and only the supervisor may write it.
			const applied = await applyMembership(peerName);
			return json(200, {
				rooms: applied,
				rebuildRequired: false,
				notice: "Membership took effect immediately.",
			});
		}

		const agentRoute = /^\/api\/agents\/([^/]+)$/.exec(path);
		if (agentRoute?.[1] !== undefined) {
			const peerName = decodeURIComponent(agentRoute[1]);
			const definition = await peerStore.get(peerName);
			if (!definition) {
				return fail(404, "not_found", `Unknown agent: ${peerName}`);
			}
			if (request.method !== "PATCH") {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}

			const payload = await readBody(request);
			if (!payload) {
				return fail(400, "invalid_request", "Body is not valid JSON");
			}
			// The name identifies the file; renaming through an edit would
			// orphan the old definition and the running peer with it.
			const { name: _ignored, ...patch } = payload;

			let result: { definition: PeerDefinition; rebuildRequired: boolean };
			try {
				result = await writeDefinition(
					{
						...fieldsOf(definition),
						...(patch as Partial<PeerDefinitionFields>),
						name: definition.name,
					},
					definition,
				);
			} catch (error) {
				return fail(
					400,
					"invalid_definition",
					error instanceof Error ? error.message : String(error),
				);
			}

			// Membership is applied live; anything else is policy, and §10.3
			// forbids applying it to a running worker. The supervisor rebuilds
			// on the next delivered turn — nothing here touches the worker.
			if (peers.has(peerName)) await applyMembership(peerName);

			return json(200, {
				agent: {
					name: result.definition.name,
					path: result.definition.filePath ?? "",
					rooms: result.definition.rooms ?? [],
				},
				rebuildRequired: result.rebuildRequired,
				notice: result.rebuildRequired
					? "Saved. The agent rebuilds on its next turn; the running session keeps the previous policy until then."
					: "Membership took effect immediately.",
			});
		}

		const reactionRoute = /^\/api\/messages\/(\d+)\/reactions\/toggle$/.exec(
			path,
		);
		if (reactionRoute?.[1] !== undefined) {
			if (request.method !== "POST") {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}
			const payload = await readBody(request);
			if (!payload) {
				return fail(400, "invalid_request", "Body is not valid JSON");
			}
			const emoji =
				typeof payload.emoji === "string" ? payload.emoji.trim() : "";
			if (emoji.length === 0) {
				return fail(400, "invalid_request", "An emoji is required");
			}
			const actor =
				typeof payload.actor === "string" && payload.actor.trim().length > 0
					? payload.actor.trim()
					: HUMAN_AUTHOR;
			if (namesAgent(actor)) {
				// Reactions carry agent status (ADR-009), so a forgeable actor
				// lets the console claim an agent picked work up.
				return fail(
					403,
					"forbidden_author",
					`The console reacts as the human; ${actor} is an agent`,
				);
			}

			const messageId = Number(reactionRoute[1]);
			const message = await findMessage(messageId);
			if (!message) {
				return fail(404, "not_found", `Unknown message: ${messageId}`);
			}

			// Keyed by (message, actor, emoji): toggling off by emoji alone
			// would take another actor's identical status reaction with it.
			const mine = message.reactions.some(
				(reaction) => reaction.actor === actor && reaction.emoji === emoji,
			);
			if (mine) await rooms.unreact(messageId, actor, emoji);
			else await rooms.react(messageId, actor, emoji);

			return json(200, {
				messageId,
				actor,
				emoji,
				reacted: !mine,
			});
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

	// ── Static client ─────────────────────────────────────────────────────────

	/**
	 * The files `src/console/` publishes, by their name on disk. A fixed set
	 * rather than a directory walk: a served tree that grows whenever someone
	 * drops a file next to the client is how a stray note or an editor backup
	 * becomes a public URL.
	 */
	const STATIC_FILES = new Set(["index.html", "app.js", "style.css"]);

	const consoleRoot = resolve(join(import.meta.dir, "..", "console"));

	/**
	 * Serve one client file, with the token carried into the shell's asset URLs.
	 *
	 * The `<link>` and `<script>` are rewritten to append `?token=` because
	 * every route here is gated and a browser sends nothing of its own on a
	 * sub-resource load: unrewritten, the console arrives as unstyled HTML with
	 * a 401'd script. The token is already in the page URL the operator pasted
	 * — `app.js` reads it from `location.search` — so this moves it nowhere new.
	 *
	 * A cookie is the other way to carry it, and is deliberately not used:
	 * cookies are scoped by host and ignore the port, so one set here would ride
	 * along to every other service on `127.0.0.1`, handing the operator token to
	 * any unrelated local dev server the browser later visits.
	 */
	const serveStatic = async (
		request: Request,
		pathname: string,
		presented: string,
	): Promise<Response> => {
		const notFound = (): Response =>
			fail(404, "not_found", `Unknown route: ${pathname}`);

		// The client is read-only: a browser only ever GETs these. Answering a
		// POST with the shell would make the static half of this server look
		// like it accepts writes it does nothing with.
		if (request.method !== "GET" && request.method !== "HEAD") {
			return fail(405, "method_not_allowed", `${request.method} not allowed`);
		}

		// Decode before resolving. The server sees the request target close to
		// verbatim — Bun collapses a literal `/../`, but leaves `%2e%2e%2f`
		// alone — so a path checked only in its encoded form is checked against
		// something other than what will be opened.
		let requested: string;
		try {
			requested = decodeURIComponent(pathname);
		} catch {
			// A malformed escape cannot name a file worth serving.
			return notFound();
		}
		if (requested.includes("\0")) return notFound();

		// Resolve-and-contain, the same standard as the peer-store write, and
		// applied to the request's own path so it is what refuses a traversal
		// rather than a formality sitting behind a lookup table.
		const path = resolve(
			join(consoleRoot, requested === "/" ? "index.html" : requested),
		);
		if (!path.startsWith(consoleRoot + sep)) return notFound();

		// Contained, and one of the files this console publishes: containment
		// alone would serve anything that happened to sit in `src/console/`.
		const filename = path.slice(consoleRoot.length + 1);
		if (!STATIC_FILES.has(filename)) return notFound();

		const file = Bun.file(path);
		if (!(await file.exists())) return notFound();

		if (filename !== "index.html") return new Response(file);

		const query = `?token=${encodeURIComponent(presented)}`;
		const html = (await file.text()).replace(
			/(<(?:script|link)\b[^>]*?\b(?:src|href)=")(\/[^"?]*)(")/g,
			`$1$2${query}$3`,
		);
		return new Response(html, {
			headers: { "content-type": "text/html;charset=utf-8" },
		});
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
			// The client's own files are the other place a query token is
			// unavoidable: a stylesheet or a script tag carries no headers.
			const isStatic = !url.pathname.startsWith("/api/");
			const presented = presentedToken(request, url, isUpgrade || isStatic);
			if (presented === undefined || !tokenMatches(presented, token)) {
				return fail(401, "unauthorized", "Operator token required");
			}

			if (isStatic) {
				return await serveStatic(request, url.pathname, presented);
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
				if (sockets.size === 0) void stopPolling();
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
			// Stop the feed first: an in-flight tick holds a store read, and it
			// must finish before the daemon closes the store under it.
			await stopPolling();
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
