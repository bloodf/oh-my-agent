/**
 * Purpose: The browser-facing half of the operator surface (§4.6). Serves the
 * console client itself from `src/console/`, plus — over loopback HTTP — the
 * reads (agents, channels, messages), the writes (create an agent or channel,
 * edit a definition, change membership, post a message, toggle a reaction),
 * and the operator operations (stop an agent, inject a message, tail its
 * logs, raise an account's ceiling). New messages, reactions, and daemon
 * transitions are pushed over a WebSocket so an open console does not poll.
 *
 * Public API: `startConsoleApi`, `ConsoleApi`, `StartConsoleApiOptions`,
 * `ConsoleEvent`.
 *
 * Upstream deps: `../rooms/store` (durable rooms, threads, reactions),
 * `./supervisor` (the seam that wakes peers, and the sole writer of a live
 * peer's cached room set), `./peer-store` (definitions on disk),
 * `./operations` (`HUMAN_AUTHOR`, `InvalidParamsError`, and the shared kill,
 * inject, logs-tail, and bump the ops routes delegate to — the same object
 * the control socket drives, so the destructive paths have one
 * implementation), a type-only `PeerRecord` from `./socket`,
 * `../shared/protocol` (`RoomInfo`, `AgentStatus`),
 * `../shared/agent-definition` (`fingerprintPeerDefinition`).
 *
 * Downstream consumers: the daemon entry point, which owns the operator token
 * and this server's lifetime, and the browser client (T-603, T-605).
 *
 * Failure modes: a request without the operator token is refused 401 before
 * anything else runs — the client's own HTML included, so a shell handed out
 * unauthenticated cannot become a fingerprinting oracle for a running daemon —
 * and that check precedes the WebSocket handshake too. Static paths are an
 * allow-list resolved and contained under `src/console/`, so no request target
 * reaches a file beside it. A write's author — or a reaction's actor, since
 * reactions carry agent status — is derived server-side as the human and any
 * client-supplied value is ignored and logged (ADR-014): the console acts as
 * the human, and a forgeable identity makes a transcript worthless. A
 * definition the parser refuses is answered 400 with the parser's own message
 * and no file is written. An operation's `InvalidParamsError` becomes a 400,
 * or a 404 when it names an agent that does not resolve; a kill answers what
 * actually happened (`cascaded`, `keptChildren`) rather than restating the
 * request, because the no-tree fallback stops the named worker alone. Errors
 * are `{error: {code, message}}` throughout.
 *
 * Performance: reads are one store query each. A definition write is one
 * render, one parse, and one atomic rename. The live feed polls only while at
 * least one WebSocket is connected, one query per known room per tick, and
 * reaction diffing is bounded to the most recent `REACTION_WINDOW` messages
 * per room.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { join, resolve, sep } from "node:path";

import type { MessageReaction, RoomMessage, RoomStore } from "../rooms/store";
import {
	fingerprintPeerDefinition,
	type PeerDefinition,
} from "../shared/agent-definition";
import type { AgentStatus, RoomInfo } from "../shared/protocol";
import { METHODS } from "../shared/protocol-schemas";
import type { Operations } from "./operations";
import { HUMAN_AUTHOR, InvalidParamsError } from "./operations";
import type { PeerDefinitionFields, PeerStore } from "./peer-store";
import type { PeerRecord } from "./socket";
import type { Supervisor } from "./supervisor";

/** Loopback: a console reachable from the network is a rooms leak. */
const DEFAULT_HOSTNAME = "127.0.0.1";

/**
 * Whether a hostname names this machine only.
 *
 * Exported because the daemon's composition root refuses a routable bind for
 * every listener before it opens any of them (ADR-012), and a second copy of
 * this predicate there is a second answer to "is this loopback" — the pair
 * would drift and the looser one would decide.
 */
export function isLoopback(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
		return true;
	}
	const match = /^(?:127)(?:\.(\d{1,3})){3}$/.exec(hostname);
	return (
		match !== null && hostname.split(".").every((part) => Number(part) <= 255)
	);
}

/** How often the live feed re-reads rooms while a console is connected. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * How far back a tick looks for reaction changes, in message ids per room.
 * Reactions carry agent status (ADR-009), which is only interesting on recent
 * traffic; without a bound, every tick would re-read a room's whole history.
 */
const REACTION_WINDOW = 200;

/**
 * Definition fields the definition read answers, mirroring the control
 * socket's own wire whitelist.
 *
 * A parsed definition carries native runtime keys — `systemPrompt`, `source` —
 * that `PeerDefinition` omits from its declared shape and that
 * `METHODS.definition_get` rejects. `sha256` and `filePath` are dropped for
 * the same reason the socket drops them: the digest is derived, and the path
 * rides beside the definition rather than inside it.
 */
const WIRE_DEFINITION_FIELDS = [
	"name",
	"description",
	"model",
	"tools",
	"spawns",
	"thinkingLevel",
	"output",
	"blocking",
	"autoloadSkills",
	"readSummarize",
	"prewalk",
	"advisor",
	"body",
	"workspace",
	"rooms",
	"wake",
	"autonomy",
	"sandbox",
	"mcps",
	"skills",
	"schedules",
	"automations",
] as const;

/**
 * A frame pushed to a connected console (ADR-015).
 *
 * The union is additive: a console may be a cached shell built against an
 * older taxonomy, so a client ignores a `type` it does not know rather than
 * treating it as a protocol error. Every frame describes one transition and
 * is emitted only after that transition commits — emitting before a write
 * that then throws publishes a state the daemon is not in.
 */
export type ConsoleEvent =
	| { type: "message"; message: RoomMessage }
	| {
			type: "reaction";
			room: string;
			messageId: number;
			actor: string;
			emoji: string;
			/** `true` when the reaction was added, `false` when it was removed. */
			reacted: boolean;
	  }
	/** A peer appeared, or its worker changed run state. */
	| { type: "agent"; agent: string; state: AgentStatus["state"] }
	/** A definition was rewritten; `rebuildRequired` is policy vs membership. */
	| { type: "definition"; agent: string; rebuildRequired: boolean }
	/** A peer's live room set, as the supervisor applied it. */
	| { type: "membership"; agent: string; rooms: string[] }
	/** A room the daemon now knows about. */
	| { type: "channel"; channel: RoomInfo }
	/** An account's quota position moved. */
	| {
			type: "budget";
			account: string;
			state: "parked" | "resumed" | "bumped" | "warned";
			/** The new ceiling, on a bump. */
			budgetUsd?: number;
	  }
	/** A peer's schedule armed or fired. */
	| { type: "schedule"; agent: string; phase: "armed" | "fired" };

export interface StartConsoleApiOptions {
	rooms: RoomStore;
	/** Every post goes through this; writing to the store leaves peers deaf. */
	supervisor: Supervisor;
	/** Registered peers by name, for status reads and membership edits. */
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
	/**
	 * Kill, inject, logs-tail, and budget-bump, shared with the control
	 * socket (T-1605).
	 *
	 * The same object `./socket` is handed, composed once in `./main`: the
	 * console does not re-implement the destructive paths, it drives them.
	 * Required rather than optional — the operations panel is part of this
	 * surface, not a capability a console may be missing, and a degraded mode
	 * nobody asked for is a mode nobody tests. A context that genuinely wires
	 * no tree passes an `Operations` built without `killPeer`, which is the
	 * documented fallback.
	 */
	operations: Operations;
	/** Operator token. Generation and storage are the daemon's concern. */
	token: string;
	/**
	 * Remote mode (ADR-012): authentication and enforcement only.
	 *
	 * The bind stays loopback in every mode — this never widens it. What it
	 * changes is what a request must carry: the operator token becomes
	 * mandatory on every path including the ones a browser can only reach
	 * with a query token, and forwarded identity is ignored until the proxy
	 * secret below proves the request actually came through the operator's
	 * own reverse proxy.
	 */
	remoteMode?: boolean;
	/**
	 * Per-install secret the reverse proxy presents, required in remote mode.
	 *
	 * Minted at boot beside the operator token. Without it, `X-Forwarded-*`
	 * is anonymous client input — a direct loopback caller can set those
	 * headers freely — so remote mode refuses a request that lacks it rather
	 * than reading an identity out of a header anyone can forge.
	 */
	proxySecret?: string;
	hostname?: string;
	/** `0` lets the OS pick, which is what the daemon and tests both want. */
	port?: number;
	pollIntervalMs?: number;
}

export interface ConsoleApi {
	url: string;
	hostname: string;
	port: number;
	/**
	 * Push one frame to every connected console.
	 *
	 * A method on the handle rather than a start option because of ordering:
	 * the daemon builds the supervisor — the thing with transitions worth
	 * publishing — before this server exists, so the destination can only be
	 * named once `startConsoleApi` has returned (ADR-015).
	 *
	 * This is the route-driven path, and the one the routes and the live-feed
	 * poller call by name: an HTTP handler that committed a write publishes it
	 * here, unconditionally. Redirecting those would take the frames away from
	 * consoles connected right now, so `publish` has no sink between it and
	 * the sockets.
	 */
	publish(event: ConsoleEvent): void;
	/**
	 * Publish one supervisor transition, through whatever sink is installed.
	 *
	 * The daemon's `SupervisorDeps.emit` hook calls this. It reads the sink
	 * at call time, so the destination set by `setPublishSink` applies to
	 * every later emission — including ones from a hook closure captured
	 * before the sink existed.
	 */
	emit(event: ConsoleEvent): void;
	/**
	 * Redirect `emit` at a sink of the daemon's choosing.
	 *
	 * Replaces the destination rather than adding an observer beside it: the
	 * default already broadcasts to the sockets, so a caller that only wanted
	 * consoles fed never has to call this. Setting again replaces the sink;
	 * `publish` is unaffected either way.
	 */
	setPublishSink(sink: (event: ConsoleEvent) => void): void;
	close(): Promise<void>;
}

/** Attached to an upgraded socket; the token was checked at the handshake. */
interface SocketData {
	id: number;
}

/** One reaction as the cursor holds it, with the message it sits on. */
interface SeenReaction extends MessageReaction {
	messageId: number;
}

/** What one room looked like at the last tick. */
interface RoomCursor {
	/** Highest message id already broadcast. */
	lastMessageId: number;
	/**
	 * Reactions already broadcast, within the window, keyed by
	 * `reactionKey`. The value carries the parts back out, so a removal names
	 * its actor and emoji without parsing them back out of the key.
	 */
	reactions: Map<string, SeenReaction>;
}

/**
 * Identity of one reaction, as a key.
 *
 * A JSON tuple rather than a delimited string: an actor and an emoji are both
 * caller-supplied text, so `${id}:${actor}:${emoji}` collides — actor `a:b`
 * with emoji `c` and actor `a` with emoji `b:c` produce the same key, and one
 * of the two reactions then never emits its removal.
 */
function reactionKey(messageId: number, actor: string, emoji: string): string {
	return JSON.stringify([messageId, actor, emoji]);
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
	const {
		rooms,
		supervisor,
		peers,
		peerStore,
		knownRooms,
		ensureRoom,
		operations,
		token,
	} = options;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const hostname = options.hostname ?? DEFAULT_HOSTNAME;
	// Unconditional, flag or no flag: there is no mode in which this listener
	// answers a routable address (ADR-012). The daemon refuses the same
	// address at boot before anything opens; this is the last line of that
	// same refusal, for a caller that reaches the module directly.
	if (!isLoopback(hostname)) {
		throw new Error(`Refusing non-loopback console bind: ${hostname}`);
	}
	const remoteMode = options.remoteMode ?? false;
	// Narrowed once, here, rather than asserted at the gate: remote mode
	// without a secret is a console that would trust forged forwarded headers,
	// so it fails to start instead of serving with the check disabled.
	const proxySecret = options.proxySecret;
	if (remoteMode && (proxySecret === undefined || proxySecret.length === 0)) {
		throw new Error(
			"Refusing remote console mode without a proxy shared secret",
		);
	}

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

	/**
	 * Push one frame to every connected console. The handle exposes this as
	 * `publish`; routes and the poller call it directly.
	 */
	const publish = (event: ConsoleEvent): void => {
		const frame = JSON.stringify(event);
		for (const socket of sockets) socket.send(frame);
	};

	/**
	 * Where supervisor transitions go, defaulting to the sockets.
	 *
	 * A default rather than `undefined` so consoles are fed with no wiring at
	 * all: a daemon that never reaches `setPublishSink` still shows every
	 * transition. `setPublishSink` replaces this, which is what makes the
	 * setter load-bearing rather than a second observer beside `publish`.
	 */
	let publishSink: (event: ConsoleEvent) => void = publish;

	/**
	 * The supervisor-facing path. Reads `publishSink` at call time, never
	 * capturing it: the daemon hands this method to the supervisor before it
	 * installs a sink, so a captured reference would pin the default forever
	 * and every later `setPublishSink` would be a no-op.
	 */
	const emit = (event: ConsoleEvent): void => {
		// Contained: the frame describes something that already happened, and
		// this runs inside the supervisor's post-commit emitters. A sink
		// throwing here would otherwise fail a park that already parked.
		//
		// Both halves of "throwing" are caught. The sink is typed `void`, which
		// admits an async function, and an async sink signals failure by
		// rejecting rather than by throwing — a rejection a plain `try` never
		// sees, and which is fatal under Bun's default. Awaiting the call
		// inside the `try` normalizes the two: a synchronous sink is
		// unaffected, because its `undefined` return awaits to itself.
		//
		// `void` on the call: this promise is deliberately detached, since
		// `emit` answers the supervisor synchronously and has no caller to
		// hand a failure back to.
		void (async () => {
			try {
				await publishSink(event);
			} catch (error) {
				process.stderr.write(
					`console: publish sink threw: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		})();
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

		// Each key maps to its parts, so a removal can name the actor and
		// emoji it is for without taking them back out of the key.
		const seen = new Map<string, SeenReaction>();
		for (const message of messages) {
			if (message.id > cursor.lastMessageId) {
				cursor.lastMessageId = message.id;
				publish({ type: "message", message });
			}
			for (const reaction of message.reactions) {
				const key = reactionKey(message.id, reaction.actor, reaction.emoji);
				seen.set(key, { messageId: message.id, ...reaction });
				if (cursor.reactions.has(key)) continue;
				publish({
					type: "reaction",
					room: roomId,
					messageId: message.id,
					actor: reaction.actor,
					emoji: reaction.emoji,
					reacted: true,
				});
			}
		}
		// The reverse diff: a key the last tick held and this read did not is
		// a reaction somebody took back, and without this a console shows it
		// forever. Bounded by the same `floor` this tick read from — a key
		// below it was never looked at, so its absence is the window moving,
		// not a removal, and emitting there would have every long-lived
		// console erase chips that are still in the store.
		for (const [key, reaction] of cursor.reactions) {
			if (reaction.messageId <= floor) continue;
			if (seen.has(key)) continue;
			publish({
				type: "reaction",
				room: roomId,
				messageId: reaction.messageId,
				actor: reaction.actor,
				emoji: reaction.emoji,
				reacted: false,
			});
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
				cursor = { lastMessageId: 0, reactions: new Map() };
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
			const cursor: RoomCursor = { lastMessageId: 0, reactions: new Map() };
			try {
				const messages = await rooms.listMessages(roomId, {});
				cursor.lastMessageId = messages.at(-1)?.id ?? 0;
				const floor = Math.max(0, cursor.lastMessageId - REACTION_WINDOW);
				for (const message of messages) {
					if (message.id <= floor) continue;
					for (const reaction of message.reactions) {
						// Seeding the *current* state is what keeps the first
						// tick silent in both directions: an addition it holds
						// is not new, and a reaction removed while nothing was
						// connected is not in here to be diffed against.
						cursor.reactions.set(
							reactionKey(message.id, reaction.actor, reaction.emoji),
							{ messageId: message.id, ...reaction },
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
	 * ADR-014: the console speaks as the human, full stop.
	 *
	 * Attribution is derived server-side rather than filtered against the peer
	 * index, because an allow-list only refuses names it happens to recognise —
	 * a stopped agent, a peer this daemon never registered, or a plain `@ceo`
	 * would all pass. Deriving it makes the guarantee unconditional.
	 *
	 * The wire keeps accepting `author`/`actor` for compatibility and ignores
	 * them rather than answering 400: refusing would break every client still
	 * sending the human label it was told to send, and there is nothing for a
	 * caller to fix, since the only value it was ever allowed to send is the
	 * one used anyway. A supplied value that is not already the human is
	 * logged, so an ignored forgery leaves a trace — quoted, because the value
	 * is caller-controlled and an embedded newline would otherwise forge a
	 * second log line.
	 */
	const humanAuthor = (supplied: unknown, what: string): string => {
		if (typeof supplied === "string" && supplied.trim().length > 0) {
			const claimed = supplied.trim();
			if (claimed !== HUMAN_AUTHOR) {
				process.stderr.write(
					`console: ignoring client-supplied ${what} ${JSON.stringify(claimed)}; recording ${HUMAN_AUTHOR}\n`,
				);
			}
		}
		return HUMAN_AUTHOR;
	};

	/**
	 * Post through the supervisor — which is what wakes subscribed peers — then
	 * read our own message back so the caller gets its id and thread fields.
	 *
	 * The read-back matches on parentage as well as author and body: the same
	 * operator sending the same words as a root and as a reply is ordinary
	 * traffic, and matching on the text alone would hand back the wrong row.
	 */
	const post = async (
		roomId: string,
		author: string,
		body: string,
		parentId: number | null,
	): Promise<RoomMessage> => {
		const before = (await rooms.listMessages(roomId, {})).at(-1)?.id ?? 0;
		await supervisor.post({ room: roomId, author, body, parentId });
		const landed = (await rooms.listMessages(roomId, { afterId: before }))
			.filter(
				(message) =>
					message.author === author &&
					message.body === body &&
					message.parentId === parentId,
			)
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

	/**
	 * Run one shared operation, mapping its refusals to HTTP.
	 *
	 * `operations.ts` raises `InvalidParamsError` for everything the caller
	 * got wrong, because that is what the control socket's dispatcher answers
	 * `invalidParams` with. Here the same failure is a 400 — except an unknown
	 * name, which is a 404, matching how every other agent route answers a
	 * name that does not resolve. Anything else is a genuine fault and is left
	 * to the outer handler, which is the difference between "you asked for
	 * something impossible" and "this daemon is broken".
	 */
	const runOperation = async (
		run: () => Promise<Response>,
	): Promise<Response> => {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof InvalidParamsError)) throw error;
			if (error.message.startsWith("Unknown agent:")) {
				return fail(404, "not_found", error.message);
			}
			return fail(400, "invalid_request", error.message);
		}
	};

	// ── Routes ────────────────────────────────────────────────────────────────

	const handle = async (request: Request, url: URL): Promise<Response> => {
		const path = url.pathname;

		// Every route below decodes the segments it captures, and a malformed
		// escape makes `decodeURIComponent` throw. Caught here, once, rather
		// than at each call site: a throw that reached the server's outer catch
		// would answer 500 for a request the client got wrong.
		//
		// The whole path stands in for its segments because a percent-escape
		// cannot straddle a separator: `/` is never a UTF-8 continuation byte,
		// so a segment that ends mid-sequence fails this decode too.
		try {
			decodeURIComponent(path);
		} catch {
			return fail(400, "invalid_request", `Malformed escape in ${path}`);
		}

		if (path === "/api/agents") {
			if (request.method === "GET") {
				const agents: (AgentStatus & { rooms: string[] })[] = [...peers].map(
					([name, record]) => ({
						name,
						state: record.worker.state,
						account: record.accountId,
						...(record.model === undefined ? {} : { model: record.model }),
						// Parentage rides along because the kill confirmation has
						// to name the children a cascade will take: counting them
						// ("and 3 children") is not something an operator can
						// check before an irreversible operation.
						...(record.parent === undefined ? {} : { parent: record.parent }),
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
				// Only rooms this call actually created are announced: a frame
				// per declared room would also name rooms that already existed,
				// and a `channel` frame means a new room, not a mention of one.
				for (const room of created.rooms ?? []) {
					const existed = knownRooms.has(room);
					await ensureRoom(room);
					const channel = knownRooms.get(room);
					if (!existed && channel) publish({ type: "channel", channel });
				}

				// After the file landed and its rooms exist: the definition on
				// disk is the commit, and a frame ahead of it would announce an
				// agent a cold boot would not find.
				publish({ type: "agent", agent: created.name, state: "stopped" });

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

		// ── Operations (T-1605) ───────────────────────────────────────────────
		//
		// Four thin handlers over the shared `operations.ts`: the console runs
		// the very same kill, inject, logs tail, and bump the control socket
		// runs. Nothing below re-implements one, and nothing below adds a
		// second auth model — reaching here already means the operator token
		// checked out.

		const opsRoute = /^\/api\/agents\/([^/]+)\/(kill|inject|logs)$/.exec(path);
		if (opsRoute?.[1] !== undefined && opsRoute[2] !== undefined) {
			const peerName = decodeURIComponent(opsRoute[1]);
			const action = opsRoute[2];
			// Unknown before anything is parsed, so a typo'd name is answered
			// 404 rather than 400 for a body nobody was going to act on.
			if (!peers.has(peerName)) {
				return fail(404, "not_found", `Unknown agent: ${peerName}`);
			}
			const wanted = action === "logs" ? "GET" : "POST";
			if (request.method !== wanted) {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}

			if (action === "logs") {
				const rawLines = url.searchParams.get("lines");
				let lines: number | undefined;
				if (rawLines !== null) {
					// Refused rather than defaulted: an operator who asked for a
					// specific depth and silently got 50 reads the wrong tail
					// and never learns the parameter was ignored.
					if (!/^\d+$/.test(rawLines) || Number(rawLines) === 0) {
						return fail(
							400,
							"invalid_request",
							"lines must be a positive integer",
						);
					}
					lines = Number(rawLines);
				}
				return await runOperation(async () =>
					json(
						200,
						await operations.logsTail({
							name: peerName,
							...(lines === undefined ? {} : { lines }),
						}),
					),
				);
			}

			const payload = await readBody(request);
			if (!payload) {
				return fail(400, "invalid_request", "Body is not valid JSON");
			}

			if (action === "inject") {
				const message =
					typeof payload.message === "string" ? payload.message.trim() : "";
				if (message.length === 0) {
					return fail(400, "invalid_request", "A message is required");
				}
				return await runOperation(async () =>
					json(200, await operations.inject(peerName, message)),
				);
			}

			// Kill. `keepChildren` is narrowed here rather than defaulted,
			// because the default is the destructive one: a value this handler
			// cannot read must be refused, never treated as absent. Coercing
			// `"true"` to "not true" would answer success while killing the
			// exact children the operator asked to spare.
			const keepChildren =
				"keepChildren" in payload ? payload.keepChildren : undefined;
			if (keepChildren !== undefined && typeof keepChildren !== "boolean") {
				return fail(
					400,
					"invalid_request",
					"keepChildren must be a boolean when present",
				);
			}
			return await runOperation(async () =>
				json(
					200,
					// The whole outcome, `keptChildren` and `cascaded` included:
					// the fallback stops only the named worker, and a response
					// that restated the request would tell an operator a subtree
					// died when one worker did.
					await operations.kill(peerName, {
						keepChildren: keepChildren === true,
					}),
				),
			);
		}

		const bumpRoute = /^\/api\/accounts\/([^/]+)\/bump$/.exec(path);
		if (bumpRoute?.[1] !== undefined) {
			if (request.method !== "POST") {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}
			const accountId = decodeURIComponent(bumpRoute[1]);
			const payload = await readBody(request);
			if (!payload) {
				return fail(400, "invalid_request", "Body is not valid JSON");
			}
			const budgetUsd = payload.budgetUsd;
			if (
				typeof budgetUsd !== "number" ||
				!Number.isFinite(budgetUsd) ||
				budgetUsd <= 0
			) {
				return fail(
					400,
					"invalid_request",
					"budgetUsd must be a positive number",
				);
			}
			return await runOperation(async () =>
				json(200, await operations.bump(accountId, budgetUsd)),
			);
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

		// A definition read, beside the PATCH that edits one. Without it the
		// console could write a definition but never load the one it was
		// about to overwrite, so an edit had to be composed blind.
		const definitionRoute = /^\/api\/agents\/([^/]+)\/definition$/.exec(path);
		if (definitionRoute?.[1] !== undefined) {
			const peerName = decodeURIComponent(definitionRoute[1]);
			if (request.method !== "GET") {
				return fail(405, "method_not_allowed", `${request.method} not allowed`);
			}
			const definition = await peerStore.get(peerName);
			if (!definition) {
				return fail(404, "not_found", `Unknown agent: ${peerName}`);
			}
			// A whitelist, not `fieldsOf`: a parsed definition also carries the
			// native runtime keys `systemPrompt` and `source`, which are not
			// part of the wire shape and which `METHODS.definition_get`
			// rejects. Answering them here would publish a definition the
			// daemon's own validator refuses, and hand the editor fields no
			// PATCH can ever send back.
			const wire: Record<string, unknown> = {};
			const source = definition as unknown as Record<string, unknown>;
			for (const key of WIRE_DEFINITION_FIELDS) {
				const value = source[key];
				if (value !== undefined) wire[key] = value;
			}
			// `filePath`, keyed as `definition_get` keys it, so the console and
			// the control socket describe a definition with one vocabulary.
			return json(200, {
				name: definition.name,
				filePath: definition.filePath ?? "",
				definition: wire,
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
			// orphan the old definition and the running peer with it. A
			// *matching* name is tolerated and dropped — a client that echoes
			// back what it read is not asking for anything — but a different
			// one is refused rather than ignored, because silently keeping the
			// old name answers 200 to a rename that never happened.
			const { name: submitted, ...patch } = payload;
			if (submitted !== undefined && submitted !== definition.name) {
				return fail(
					400,
					"invalid_request",
					`An agent cannot be renamed through an edit: ${definition.name} is immutable`,
				);
			}

			// Validated against the very contract the control socket enforces,
			// before anything is merged. `renderPeerDefinition` emits a fixed
			// key list, so a field the schema does not know is dropped on the
			// way to disk and the write succeeds — answering 200 for an edit
			// that never happened. A typo'd key has to be refused here, in the
			// operator's own words, exactly as `definition_update` refuses it.
			const validated = METHODS.definition_update.validateParams({
				name: definition.name,
				changes: patch,
			});
			if (!validated.ok) {
				return fail(
					400,
					"invalid_definition",
					`${validated.field}: ${validated.message}`,
				);
			}

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

			// After both the file and, where it applied, the live room set:
			// `applyMembership` publishes its own membership frame through the
			// supervisor, so this one carries only what that does not — that a
			// definition changed, and whether a rebuild is owed.
			publish({
				type: "definition",
				agent: result.definition.name,
				rebuildRequired: result.rebuildRequired,
			});

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
			// Reactions carry agent status (ADR-009), so a forgeable actor would
			// let the console claim an agent picked work up.
			const actor = humanAuthor(payload.actor, "reaction actor");

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
				// `ensureRoom` is idempotent, so a repeated create is not a
				// transition: a frame for it would have every console repaint
				// a channel list that did not change.
				const existed = knownRooms.has(id);
				await ensureRoom(id);
				const channel = knownRooms.get(id);
				if (!channel) {
					return fail(500, "internal", `Channel ${id} was not indexed`);
				}
				// After the room exists and is indexed, so a console acting on
				// the frame finds it on the very next read.
				if (!existed) publish({ type: "channel", channel });
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
						? (payload as {
								body?: unknown;
								author?: unknown;
								parentId?: unknown;
							})
						: {};
				const body = typeof fields.body === "string" ? fields.body.trim() : "";
				if (body.length === 0) {
					return fail(400, "invalid_request", "Message body is required");
				}
				// Absent and null both mean "a root"; anything else has to be a
				// real message id, because a `0` or a `"12"` reaching the store
				// would either be silently dropped or refused as a server error
				// rather than answered as the caller's mistake.
				let parentId: number | null = null;
				if (fields.parentId !== undefined && fields.parentId !== null) {
					if (
						typeof fields.parentId !== "number" ||
						!Number.isInteger(fields.parentId) ||
						fields.parentId < 1
					) {
						return fail(
							400,
							"invalid_request",
							"parentId must be a positive integer message id",
						);
					}
					parentId = fields.parentId;
				}
				const author = humanAuthor(fields.author, "post author");
				try {
					return json(201, {
						message: await post(roomId, author, body, parentId),
					});
				} catch (error) {
					// Thread parentage is the store's rule to enforce — it alone
					// knows the room's history — so its refusal is relayed in its
					// own words rather than restated here.
					//
					// Only those two are the caller's fault. Everything else — a
					// dead worker, a post that never landed — is the daemon's,
					// and is rethrown to the 500 the server wraps `handle` in:
					// answering 400 would tell an operator to fix a message that
					// was never wrong, and hide an outage as a typo.
					const failure =
						error instanceof Error ? error.message : String(error);
					if (
						failure !== "MESSAGE_NOT_IN_ROOM" &&
						failure !== "MESSAGE_NOT_FOUND"
					) {
						throw error;
					}
					return fail(400, "invalid_request", failure);
				}
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
			// Remote mode only. The forwarded headers a proxy sets are also
			// headers a direct loopback caller can set, so they mean nothing
			// until this per-install secret proves the request came through
			// the operator's own proxy. Checked before any route runs, so
			// there is no path on which forged `X-Forwarded-*` is read first
			// and refused second.
			if (remoteMode && proxySecret !== undefined) {
				const presentedSecret = request.headers.get("X-OMA-Proxy-Secret");
				if (
					presentedSecret === null ||
					!tokenMatches(presentedSecret, proxySecret)
				) {
					return fail(401, "unauthorized", "Proxy shared secret required");
				}
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
		publish,
		emit,
		setPublishSink: (sink) => {
			publishSink = sink;
		},
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
