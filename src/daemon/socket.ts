/**
 * Purpose: Serve the T-507 control protocol over the daemon's unix socket
 * (§4.1) — the single surface the TUI, the worker toolbelt, and the web console
 * reach the daemon through, so none of them touches daemon state or the
 * database directly.
 *
 * Public API: `startControlSocket(options): Promise<ControlSocket>`, identity
 * types, the `DaemonContext`, and — re-exported from `./operations`, which
 * owns them — `HUMAN_AUTHOR` and `InvalidParamsError`.
 *
 * Upstream deps: `../shared/protocol` (frames, error builders, version),
 * `../shared/protocol-schemas` (`METHODS`), `../rooms/store`,
 * `../worker/lifecycle` (sandbox state), `./supervisor`, and `./operations`
 * (the shared kill, inject, logs-tail, and bump the four matching handlers
 * delegate to, plus the two values above).
 *
 * Downstream consumers: `./main`, which owns composition and lifetime; every
 * operator client speaks to this socket rather than to those objects.
 *
 * Failure modes: protocol problems are data, never exceptions. Missing or
 * unknown bearers answer `unauthorized`; in remote mode every operator-only
 * surface answers `unauthorized` to a worker bearer too — the methods outside
 * `workerMethods` and `logs_tail`'s `source: "daemon"` selector — because
 * those authenticate against the operator token specifically (ADR-012 (a)).
 * Authenticated callers outside their own scope answer `forbidden`; malformed
 * calls retain their declared protocol errors. Handler throws answer an
 * internal error. A worker's chat attribution is overwritten with its own
 * identity rather than refused (ADR-014); the operator token keeps full
 * override as the human's privileged credential.
 *
 * Performance: one dispatch per request. `chat_wait` parks on a polling loop;
 * reaction state checks scan public message listings across known rooms.
 * `close()` wakes polling sleeps so shutdown never waits out a long poll.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	constants,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RoomStore, RoomMessage as StoredMessage } from "../rooms/store";
import type { PeerDefinition } from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";
import type {
	AgentCreateParams,
	AgentCreateResult,
	AgentSpawnParams,
	AgentSpawnResult,
	AgentStatus,
	AgentStatusParams,
	AgentStatusResult,
	BumpParams,
	BumpResult,
	ChatReactionParams,
	ChatReactResult,
	ChatReadParams,
	ChatReadResult,
	ChatSendParams,
	ChatSendResult,
	ChatUnreactResult,
	ChatWaitParams,
	ChatWaitResult,
	DaemonStopParams,
	DaemonStopResult,
	DefinitionData,
	DefinitionGetParams,
	DefinitionGetResult,
	DefinitionUpdateParams,
	DefinitionUpdateResult,
	InjectParams,
	InjectResult,
	JsonRpcFailure,
	JsonRpcId,
	KillParams,
	KillResult,
	LogsTailParams,
	LogsTailResult,
	MethodName,
	RoomInfo,
	RoomMessage,
	RoomsListParams,
	RoomsListResult,
	RoomsPostParams,
	RoomsPostResult,
	ScheduleInfo,
	SchedulesArmParams,
	SchedulesArmResult,
	SchedulesListParams,
	SchedulesListResult,
	StatusParams,
	StatusResult,
	TaskHandoffParams,
	TaskHandoffResult,
} from "../shared/protocol";
import {
	ERROR_CODE,
	forbidden,
	invalidParams,
	methodNotFound,
	PROTOCOL_VERSION,
	unauthorized,
} from "../shared/protocol";
import { METHODS } from "../shared/protocol-schemas";
import type { WorkerHandle } from "../worker/lifecycle";
import type { Operations } from "./operations";
import {
	createOperations,
	HUMAN_AUTHOR,
	InvalidParamsError,
} from "./operations";
import type { PeerDefinitionFields, PeerStore } from "./peer-store";
import type { SupervisedWorker, Supervisor } from "./supervisor";

/** Default ceiling for a parked `chat_wait`, per T-507's payload contract. */
const DEFAULT_WAIT_MS = 30_000;

/** How often a parked wait re-reads the room. Woken early on close. */
const WAIT_POLL_MS = 50;

/** Maximum live connections retained and exposed by `omp-agent audit`. */
const MAX_AUDIT_CONNECTIONS = 32;

/** Maximum copied peer-identity length, bounding serialized audit state. */
const MAX_AUDIT_IDENTITY_LENGTH = 256;

export type AuditConnectionClass =
	| "control-socket"
	| "console-loopback"
	| "console-proxied";

export interface AuditConnection {
	id: string;
	identity: string;
	class: AuditConnectionClass;
	source: string;
	connectedAt: string;
}

export interface ConnectionAuditRecorder {
	connect(
		identity: string,
		connectionClass: AuditConnectionClass,
		source: string,
	): Promise<AuditConnection | undefined>;
	disconnect(connection: AuditConnection): Promise<void>;
}

/** Per-daemon bridge: both listeners receive the same `Operations` instance. */
const auditRecorders = new WeakMap<Operations, ConnectionAuditRecorder>();

/** Resolve the recorder registered by the control socket for this daemon. */
export function connectionAuditRecorder(
	operations: Operations,
): ConnectionAuditRecorder | undefined {
	return auditRecorders.get(operations);
}

export function persistConnectionAuditState(
	path: string,
	serialized: string,
	suffix = randomBytes(16).toString("hex"),
): void {
	const temporary = `${path}.${suffix}.tmp`;
	let descriptor: number | undefined;
	let created = false;
	try {
		descriptor = openSync(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		created = true;
		writeFileSync(descriptor, serialized, { encoding: "utf8" });
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (created) {
			try {
				unlinkSync(temporary);
			} catch {
				// Best effort: rename already consumed successful temporary files.
			}
		}
	}
}

async function createConnectionAuditRecorder(
	path: string,
	trustModel: "loopback" | "remote",
): Promise<ConnectionAuditRecorder> {
	const directory = statSync(dirname(path));
	const uid = process.getuid?.();
	if (
		uid === undefined ||
		directory.uid !== uid ||
		(directory.mode & (constants.S_IWGRP | constants.S_IWOTH)) !== 0
	) {
		throw new Error(
			`Refusing unsafe audit state directory: ${dirname(path)} must be owned by this user and not group- or world-writable`,
		);
	}
	let connections: AuditConnection[] = [];
	const persist = (): void => {
		persistConnectionAuditState(
			path,
			JSON.stringify({ version: 1, trustModel, connections }),
		);
	};

	const emit = (
		event: "connect" | "disconnect",
		connection: AuditConnection,
	): void => {
		process.stderr.write(
			`audit: ${JSON.stringify({
				event,
				identity: connection.identity,
				class: connection.class,
				source: connection.source,
				at: new Date().toISOString(),
			})}\n`,
		);
	};

	persist();
	return {
		connect: async (identity, connectionClass, source) => {
			if (connections.length >= MAX_AUDIT_CONNECTIONS) return undefined;
			const connection: AuditConnection = {
				id: randomBytes(12).toString("base64url"),
				identity: identity.slice(0, MAX_AUDIT_IDENTITY_LENGTH),
				class: connectionClass,
				source: source.slice(0, MAX_AUDIT_IDENTITY_LENGTH),
				connectedAt: new Date().toISOString(),
			};
			connections = [...connections, connection];
			emit("connect", connection);
			persist();
			return connection;
		},
		disconnect: async (connection) => {
			connections = connections.filter(
				(candidate) => candidate.id !== connection.id,
			);
			emit("disconnect", connection);
			persist();
		},
	};
}

/**
 * Definition fields the wire carries, in `METHODS`' own order.
 *
 * Exactly the schema's `DEFINITION_FIELDS`, and deliberately a whitelist: a
 * parsed definition also carries native runtime keys (`systemPrompt`,
 * `source`) that the validator rejects, so copying what is allowed is the only
 * mapping that cannot drift into answering a frame the daemon itself refuses.
 */
const WIRE_DEFINITION_KEYS = [
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
	"sha256",
] as const;

/** A peer the daemon has registered with the supervisor. */
export interface PeerRecord {
	worker: SupervisedWorker &
		Partial<Pick<WorkerHandle, "sandboxed" | "stderr" | "pid">>;
	accountId: string;
	model?: string;
	rooms: string[];
	/**
	 * Who deployed this peer, or undefined for a root.
	 *
	 * Cooperative metadata (ADR-011): the spawning worker self-asserts it and
	 * the socket trusts every caller equally, so this may describe the tree and
	 * may never authorize anything until real connection identity exists.
	 */
	parent?: string;
}

/** A schedule or automation armed from a peer definition. */
export interface ScheduleRecord {
	id: string;
	peer: string;
	/** `null` for an automation, which fires on an event rather than a clock. */
	cron: string | null;
	action: string;
	enabled: boolean;
	nextFireAt: number | null;
}

/**
 * Everything the protocol handlers may touch. Composition, worker construction,
 * and lifetime stay in `./main`: this module turns wire frames into calls on
 * these, and nothing else.
 */
export interface DaemonContext {
	rooms: RoomStore;
	supervisor: Supervisor;
	/** Registered peers by name. */
	peers: Map<string, PeerRecord>;
	/** Rooms the daemon knows about; the store does not enumerate them. */
	knownRooms: Map<string, RoomInfo>;
	schedules: Map<string, ScheduleRecord>;
	/**
	 * Agents registered but deliberately not started, because their parent is
	 * gone. Keyed by name, valued by the parent that vanished.
	 *
	 * Deliberately not a `peers` entry with a stubbed worker: an orphan has no
	 * lifecycle, and a placeholder in `peers` would be reachable by `kill`,
	 * `inject`, `logs_tail`, and the shutdown sweep, all of which would then be
	 * driving a worker that does not exist. Status is the only surface that
	 * merges the two, because reporting the orphan is the entire purpose.
	 */
	orphans?: Map<string, string>;
	/**
	 * Definitions as they sit on disk; the authoring methods read and write
	 * here.
	 *
	 * Optional because a context assembled for one narrow surface — the TUI
	 * harness, the toolbelt — has no business writing definitions. The
	 * authoring methods answer `invalidParams` rather than throwing when it is
	 * absent, so an unwired context degrades to "not available here" instead of
	 * an internal error.
	 */
	store?: PeerStore;
	/**
	 * Write a definition through the store and refresh the daemon's own view of
	 * it.
	 *
	 * Separate from `store` because writing to disk is only half the operation:
	 * `spawnPeer` resolves a name against the daemon's `definitions` map, so a
	 * create the map never learned about is followed by "unknown peer" on the
	 * spawn the caller was told to make next. Optional for the same reason
	 * `store` is.
	 */
	writeDefinition?(
		fields: PeerDefinitionFields,
		options: { overwrite: boolean },
	): Promise<PeerDefinition>;
	startedAt: number;
	now(): number;
	/** Create the room if it does not exist yet, and index it. */
	ensureRoom(id: string): Promise<void>;
	/**
	 * Build and register a peer's worker. Rejects an unknown peer name.
	 *
	 * `parent` is spawn-time state: it decides the account and family channel
	 * this peer starts with, and is rejected when it is unknown, stopped, or
	 * would close a loop.
	 */
	spawnPeer(
		name: string,
		options?: { parent?: string },
	): Promise<AgentSpawnResult>;
	/**
	 * Stop a peer and, by default, everything under it. `keepChildren`
	 * reparents its children to root instead, which is the only way a child
	 * outlives its parent.
	 *
	 * Optional: a context that wires no tree has no subtree to cascade through,
	 * and `kill` falls back to stopping the named worker alone.
	 */
	killPeer?(name: string, options: { keepChildren: boolean }): Promise<void>;
	/** Enable or disable an armed schedule. Returns undefined when unknown. */
	armSchedule(id: string, enabled: boolean): ScheduleInfo | undefined;
	/** Raise a metered account's ceiling and resume it. Returns the peers the bump resumed. */
	bumpAccount(accountId: string, budgetUsd: number): Promise<string[]>;
	/**
	 * Begin this daemon's shutdown and answer what the caller may watch.
	 *
	 * Owned by `./main` because only the composition root knows the pidfile it
	 * claimed and the close path it built. It validates that ownership, is
	 * idempotent, and — critically — *schedules* the close rather than awaiting
	 * it, so this handler can answer before the socket it answered on is gone.
	 *
	 * Optional for the same reason `store` is: a context assembled for one
	 * narrow surface owns no daemon lifetime, and the handler answers
	 * `invalidParams` rather than throwing when it is absent.
	 */
	requestDaemonStop?(): Promise<DaemonStopResult>;
	/**
	 * The daemon's own stderr log, most recent lines last. Absent on a context
	 * that has no daemon log to read, where `logs_tail` refuses the `daemon`
	 * source rather than answering an empty tail that reads as "nothing was
	 * logged".
	 */
	daemonLog?(): Promise<string>;
	/**
	 * Kill, inject, logs-tail, and bump, shared with the console API.
	 *
	 * Optional so a context assembled for one narrow surface still works: this
	 * module derives an equivalent one from the fields above when it is
	 * absent. What it is *not* is a second implementation — `./main` composes
	 * exactly one and hands it to both surfaces, so the destructive paths
	 * cannot drift apart between the socket and the browser (T-1605).
	 */
	operations?: Operations;
}

export interface ControlSocket {
	socketPath: string;
	close(): Promise<void>;
}

export type ControlIdentity =
	| { kind: "operator" }
	| { kind: "worker"; peerName: string };

/**
 * Bearer authentication here is unconditional: this listener refuses any
 * connection whose bearer resolves to no registered identity, in every mode
 * and including the default empty registry.
 *
 * Remote mode adds the scope half of ADR-012 clause (a): the operator surface
 * authenticates against the operator token specifically, so a worker bearer
 * reaching it is refused as a caller that did not present this surface's
 * credential, not as a registered caller out of scope. That surface is every
 * method outside `workerMethods`, plus `logs_tail`'s `source: "daemon"`
 * selector, which is operator-only inside a worker-callable method.
 *
 * Clause (b) keeps worker methods reachable with scoped tokens in both modes.
 * Remote mode additionally binds worker-created parentage to that resolved
 * identity; loopback keeps cooperative parent delegation.
 */
export interface StartControlSocketOptions {
	socketPath: string;
	context: DaemonContext;
	/**
	 * Bearer → identity. Resolved by constant-time comparison rather than by
	 * `get`, so a caller cannot learn a valid prefix from how long a lookup
	 * takes (ADR-012). The map is still the registry the daemon mutates as
	 * workers come and go; only the read is different.
	 */
	identities?: ReadonlyMap<string, ControlIdentity>;
	/**
	 * Whether the daemon was booted with `OMA_REMOTE=1`. Absent means loopback,
	 * which is what every existing caller composes.
	 *
	 * Read by `authorize`, and only there: it selects which refusal a worker
	 * bearer gets on an operator-only surface and whether worker spawns require
	 * self-parentage. Loopback answers `forbidden` on operator-only surfaces — a
	 * registered caller outside its scope — which is byte-identical to the
	 * behavior that predates this flag. Remote answers `unauthorized`, because
	 * ADR-012 clause (a) makes the operator token the credential the operator
	 * surface authenticates against, and a worker token is not that credential.
	 * Remote worker spawns must name their caller as parent; loopback preserves
	 * cooperative foreign or omitted parents.
	 *
	 * Applied at both operator-only surfaces, so the rule is the surface's
	 * rather than the method table's: the methods outside `workerMethods`, and
	 * `logs_tail`'s daemon-log selector. A worker reading another worker's
	 * logs stays `forbidden` in both modes — that is scoping within the worker
	 * surface, not an operator resource.
	 *
	 * What it deliberately does not change: the bearer requirement itself,
	 * which is unconditional in both modes, or access to worker methods with a
	 * scoped token over this same unix path.
	 */
	remoteMode?: boolean;
}

/**
 * Re-exported from `./operations`, which owns both because the operations and
 * the protocol handlers raise them and this module imports that one. Keeping
 * the definitions here would make the pair a value-level import cycle.
 */
export { HUMAN_AUTHOR, InvalidParamsError };

/** Params each method's handler receives, already validated by `METHODS`. */
interface ParamsByMethod {
	status: StatusParams;
	chat_send: ChatSendParams;
	chat_read: ChatReadParams;
	chat_wait: ChatWaitParams;
	chat_react: ChatReactionParams;
	chat_unreact: ChatReactionParams;
	agent_spawn: AgentSpawnParams;
	agent_create: AgentCreateParams;
	definition_get: DefinitionGetParams;
	definition_update: DefinitionUpdateParams;
	agent_status: AgentStatusParams;
	logs_tail: LogsTailParams;
	inject: InjectParams;
	task_handoff: TaskHandoffParams;
	rooms_list: RoomsListParams;
	rooms_post: RoomsPostParams;
	schedules_list: SchedulesListParams;
	schedules_arm: SchedulesArmParams;
	/**
	 * `keep_children` rides along unvalidated by `METHODS`, which checks only
	 * the fields it declares. Typed `unknown` rather than `boolean` so the
	 * handler must narrow it before acting: the wire can carry anything here,
	 * and this is the one destructive method where guessing is unacceptable.
	 */
	kill: KillParams & { keep_children?: unknown };
	bump: BumpParams;
	daemon_stop: DaemonStopParams;
}

type Handlers = {
	[K in MethodName]: (params: ParamsByMethod[K]) => Promise<unknown>;
};

/** Preserve additive mention, threading, and reaction metadata on the wire. */
function toWireMessage(message: StoredMessage): RoomMessage {
	const wire: RoomMessage = {
		id: message.id,
		room: message.room,
		author: message.author,
		body: message.body,
		createdAt: message.createdAt,
		parentId: message.parentId,
		threadRootId: message.threadRootId,
		replyCount: message.replyCount,
		reactions: message.reactions,
	};
	if (message.mentions.length > 0) wire.mentions = message.mentions;
	return wire;
}

/**
 * Every agent's wire status: the live peers, then the orphans the daemon
 * registered but refused to start.
 *
 * The two live in different maps on purpose — an orphan has no worker to drive
 * — and this is the one place they are merged, because a tree that hid its
 * refused nodes would leave an operator wondering where an agent went.
 *
 * `children` is derived from the parent edges rather than stored, so it can
 * never disagree with the edges it is the inverse of. An orphan still counts
 * as a child of its vanished parent, which is what makes the break visible.
 */
function toAgentStatuses(
	peers: Map<string, PeerRecord>,
	orphans: Map<string, string>,
): AgentStatus[] {
	const parentOf = new Map<string, string>();
	for (const [name, record] of peers) {
		if (record.parent !== undefined) parentOf.set(name, record.parent);
	}
	for (const [name, parent] of orphans) parentOf.set(name, parent);

	const childrenOf = (name: string): string[] =>
		[...parentOf]
			.filter(([, parent]) => parent === name)
			.map(([child]) => child)
			.sort();

	const statuses: AgentStatus[] = [...peers].map(([name, record]) => ({
		name,
		state: record.worker.state,
		account: record.accountId,
		...(record.model === undefined ? {} : { model: record.model }),
		sandboxed: record.worker.sandboxed,
		...(record.worker.pid === undefined ? {} : { pid: record.worker.pid }),
		...(record.parent === undefined ? {} : { parent: record.parent }),
		children: childrenOf(name),
	}));

	for (const [name, parent] of orphans) {
		if (peers.has(name)) continue;
		statuses.push({
			name,
			// Never started, so never anything but stopped.
			state: "stopped",
			account: "unknown",
			parent,
			children: childrenOf(name),
			// Only ever true, never a false flag on every healthy agent: an
			// absent field reads as "fine" in clients that predate orphans.
			orphaned: true,
		} as AgentStatus);
	}
	return statuses;
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: { code, message, data: { protocolVersion: PROTOCOL_VERSION } },
	};
}

/**
 * Compare over digests rather than raw bytes: `timingSafeEqual` throws on a
 * length mismatch, and branching on length first would leak the credential's
 * size. Hashing makes both operands 32 bytes whatever the input.
 *
 * Mirrors `./console-api`'s own comparison — the two listeners are separate
 * modules and neither imports the other, so the constant-time property is
 * stated at each surface rather than shared through a third module this
 * task's file scope may not create.
 */
function tokenMatches(presented: string, expected: string): boolean {
	const left = createHash("sha256").update(presented).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}

export async function startControlSocket(
	options: StartControlSocketOptions,
): Promise<ControlSocket> {
	const {
		socketPath,
		context,
		identities = new Map(),
		remoteMode = false,
	} = options;

	/**
	 * The shared operations, or an equivalent derived from this context.
	 *
	 * The daemon composes one and passes it in, so the socket and the console
	 * drive the very same kill; a context assembled for a narrower surface
	 * (a test harness, the toolbelt) gets one built over its own fields
	 * instead of losing four methods.
	 */
	const operations: Operations =
		context.operations ??
		createOperations({
			rooms: context.rooms,
			supervisor: context.supervisor,
			peers: context.peers,
			...(context.killPeer === undefined
				? {}
				: { killPeer: context.killPeer.bind(context) }),
			bumpAccount: context.bumpAccount.bind(context),
			...(context.daemonLog === undefined
				? {}
				: { daemonLog: context.daemonLog.bind(context) }),
		});
	const audit = remoteMode
		? await createConnectionAuditRecorder(
				join(dirname(socketPath), "connection-audit.json"),
				"remote",
			)
		: undefined;
	if (audit === undefined) {
		await unlink(join(dirname(socketPath), "connection-audit.json")).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			},
		);
	} else {
		auditRecorders.set(operations, audit);
	}

	let closing = false;

	// A parked `chat_wait` sleeps for `WAIT_POLL_MS` at a time and re-checks
	// `closing`, so shutdown is bounded by one poll interval rather than by the
	// caller's timeout. That bound is what keeps `close()` from waiting out a
	// 30-second long poll, and it needs no wake-up bookkeeping to hold.
	const nap = (): Promise<void> =>
		closing ? Promise.resolve() : Bun.sleep(WAIT_POLL_MS);

	/** Messages after `sinceId`, in one room or across every known room. */
	const collect = async (
		room: string | undefined,
		sinceId: number,
	): Promise<RoomMessage[]> => {
		const ids = room === undefined ? [...context.knownRooms.keys()] : [room];
		const collected: RoomMessage[] = [];
		for (const id of ids) {
			const messages = await context.rooms.listMessages(id, {
				afterId: sinceId,
			});
			for (const message of messages) collected.push(toWireMessage(message));
		}
		return collected.sort((left, right) => left.id - right.id);
	};

	const findMessage = async (
		messageId: number,
	): Promise<StoredMessage | undefined> => {
		for (const room of context.knownRooms.keys()) {
			const message = (await context.rooms.listMessages(room, {})).find(
				(candidate) => candidate.id === messageId,
			);
			if (message) return message;
		}
		return undefined;
	};

	const bears = (
		message: StoredMessage | undefined,
		params: ChatReactionParams,
	): boolean =>
		message?.reactions.some(
			(reaction) =>
				reaction.actor === params.actor && reaction.emoji === params.emoji,
		) === true;

	const hasReaction = async (params: ChatReactionParams): Promise<boolean> =>
		bears(await findMessage(params.messageId), params);

	let reactionQueue = Promise.resolve();
	const serializeReaction = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = reactionQueue.then(operation);
		reactionQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	/**
	 * Post through the supervisor — which is what delivers to subscribed peers —
	 * then read our own message back so the caller gets its id.
	 */
	const post = async (params: ChatSendParams): Promise<ChatSendResult> => {
		const author = params.author ?? HUMAN_AUTHOR;
		await context.ensureRoom(params.room);

		const before = (await collect(params.room, 0)).at(-1)?.id ?? 0;
		await context.supervisor.post({
			room: params.room,
			author,
			body: params.body,
		});

		const landed = (await collect(params.room, before)).findLast(
			(message) => message.author === author && message.body === params.body,
		);
		if (!landed) throw new Error(`Post to ${params.room} did not land`);
		return { messageId: landed.id, createdAt: landed.createdAt };
	};

	/**
	 * The store, or a refusal naming why authoring is unavailable here.
	 *
	 * Three handlers need it and each must answer `invalidParams` rather than
	 * throw, so the check is shared rather than repeated three ways.
	 */
	const requireStore = (): PeerStore => {
		if (!context.store) {
			throw new InvalidParamsError(
				"name",
				"Definition authoring is not available on this daemon",
			);
		}
		return context.store;
	};

	/**
	 * A definition as the wire carries it.
	 *
	 * Copied field by field rather than spread-minus-`filePath`. `parseAgent`
	 * spreads its own native result, so a parsed definition carries runtime
	 * keys — `systemPrompt`, `source` — that `PeerDefinition` omits from its
	 * declared shape and `METHODS.definition_get` rejects. Omitting only
	 * `filePath` and casting produces an object the compiler accepts and the
	 * daemon's own result validator refuses at `definition.systemPrompt`.
	 */
	const toDefinitionData = (definition: PeerDefinition): DefinitionData => {
		const source = definition as unknown as Record<string, unknown>;
		const data: Record<string, unknown> = {};
		for (const key of WIRE_DEFINITION_KEYS) {
			const value = source[key];
			if (value !== undefined) data[key] = value;
		}
		return data as unknown as DefinitionData;
	};

	/** The definition writer, or a refusal naming why authoring is unavailable. */
	const requireWriteDefinition = (): NonNullable<
		DaemonContext["writeDefinition"]
	> => {
		const write = context.writeDefinition;
		if (!write) {
			throw new InvalidParamsError(
				"name",
				"Definition authoring is not available on this daemon",
			);
		}
		return write;
	};

	const handlers: Handlers = {
		status: async (): Promise<StatusResult> => ({
			protocolVersion: PROTOCOL_VERSION,
			agents: toAgentStatuses(context.peers, context.orphans ?? new Map()),
			uptimeMs: context.now() - context.startedAt,
		}),

		chat_send: async (params): Promise<ChatSendResult> => await post(params),

		rooms_post: async (params): Promise<RoomsPostResult> => await post(params),

		chat_read: async (params): Promise<ChatReadResult> => {
			await context.ensureRoom(params.room);
			const messages = await context.rooms.listMessages(params.room, {
				afterId: params.sinceId,
				limit: params.limit,
			});
			return { messages: messages.map(toWireMessage) };
		},

		chat_wait: async (params): Promise<ChatWaitResult> => {
			if (params.room !== undefined) await context.ensureRoom(params.room);

			// A wait with no cursor means "anything after now", not "replay the
			// backlog" — otherwise every bare wait returns instantly.
			const baseline =
				params.sinceId ?? (await collect(params.room, 0)).at(-1)?.id ?? 0;
			const deadline = context.now() + (params.timeoutMs ?? DEFAULT_WAIT_MS);

			while (!closing) {
				const messages = await collect(params.room, baseline);
				if (messages.length > 0) return { messages };
				if (context.now() >= deadline) break;
				await nap();
			}
			return { messages: [] };
		},

		chat_react: async (params): Promise<ChatReactResult & { reacted: true }> =>
			await serializeReaction(async () => {
				const added = !(await hasReaction(params));
				try {
					await context.rooms.react(
						params.messageId,
						params.actor,
						params.emoji,
					);
				} catch (error) {
					if (error instanceof Error && error.message === "MESSAGE_NOT_FOUND") {
						throw new InvalidParamsError(
							"messageId",
							`Unknown message: ${params.messageId}`,
						);
					}
					throw error;
				}
				return { ...params, added, reacted: true };
			}),

		chat_unreact: async (
			params,
		): Promise<ChatUnreactResult & { reacted: false }> =>
			await serializeReaction(async () => {
				// The store's unreact is idempotent and never throws, so the
				// handler owns the existence check that react gets for free.
				const message = await findMessage(params.messageId);
				if (!message) {
					throw new InvalidParamsError(
						"messageId",
						`Unknown message: ${params.messageId}`,
					);
				}
				const removed = bears(message, params);
				await context.rooms.unreact(
					params.messageId,
					params.actor,
					params.emoji,
				);
				return { ...params, removed, reacted: false };
			}),

		rooms_list: async (): Promise<RoomsListResult> => ({
			rooms: [...context.knownRooms.values()],
		}),

		agent_status: async (params): Promise<AgentStatusResult> => {
			const agents = toAgentStatuses(
				context.peers,
				context.orphans ?? new Map(),
			);
			if (params.name === undefined) return { agents };
			const named = agents.find((agent) => agent.name === params.name);
			if (!named) {
				throw new InvalidParamsError("name", `Unknown agent: ${params.name}`);
			}
			return { agents: [named] };
		},

		/**
		 * A stderr tail, from a worker by default or from the daemon itself.
		 *
		 * `source` selects the stream rather than overloading `name`, because a
		 * peer may legitimately be called "daemon" and a name-sniffing shortcut
		 * would hijack its logs the moment someone defined one.
		 */
		logs_tail: async (params): Promise<LogsTailResult> =>
			await operations.logsTail({
				name: params.name,
				...(params.lines === undefined ? {} : { lines: params.lines }),
				...(params.source === undefined ? {} : { source: params.source }),
			}),

		inject: async (params): Promise<InjectResult> =>
			await operations.inject(params.name, params.message),

		agent_spawn: async (params): Promise<AgentSpawnResult> =>
			await context.spawnPeer(params.name, { parent: params.parent }),

		/**
		 * Write a parse-validated definition, so an LLM caller gets a checkpoint
		 * before anything runs (ADR-011). Creation never starts the peer:
		 * `agent_spawn` is the second call, and the split is the point.
		 *
		 * Routed through `writeDefinition` rather than straight at the store,
		 * because the daemon's `definitions` map is what `spawnPeer` resolves a
		 * name against — a write that only reached disk would be answered by
		 * "unknown peer" on the very next call the caller is expected to make.
		 */
		agent_create: async (params): Promise<AgentCreateResult> => {
			const write = requireWriteDefinition();
			const { name, ...rest } = params;
			try {
				await write({ ...rest, name } as PeerDefinitionFields, {
					overwrite: false,
				});
			} catch (error) {
				// The parser's own words, and the store's name conflict, are both
				// answers to what the caller sent — not internal faults.
				throw new InvalidParamsError(
					"name",
					error instanceof Error ? error.message : String(error),
				);
			}
			return { name, created: true };
		},

		definition_get: async (params): Promise<DefinitionGetResult> => {
			const store = requireStore();
			const definition = await store.get(params.name);
			if (!definition) {
				throw new InvalidParamsError("name", `Unknown peer: ${params.name}`);
			}
			return {
				name: params.name,
				definition: toDefinitionData(definition),
				filePath: definition.filePath ?? "",
			};
		},

		/**
		 * Rewrite a definition, and report whether the change is one a running
		 * worker cannot absorb.
		 *
		 * Nothing is restarted here. A policy change is answered by T-505's
		 * staleness check on the next delivery, which stops the superseded
		 * worker and rebuilds before prompting — §10.3 forbids hot reload, and
		 * restarting from here would apply an edit to a peer mid-turn.
		 */
		definition_update: async (params): Promise<DefinitionUpdateResult> => {
			const store = requireStore();
			const write = requireWriteDefinition();
			const current = await store.get(params.name);
			if (!current) {
				throw new InvalidParamsError("name", `Unknown peer: ${params.name}`);
			}

			const fields = {
				...toDefinitionData(current),
				...params.changes,
				name: params.name,
			} as unknown as PeerDefinitionFields;

			let written: PeerDefinition;
			try {
				written = await write(fields, { overwrite: true });
			} catch (error) {
				throw new InvalidParamsError(
					"changes",
					error instanceof Error ? error.message : String(error),
				);
			}

			// Membership is applied live by the supervisor and is subtracted out
			// of the staleness comparison, so a rooms-only edit is not a rebuild.
			// Everything the fingerprint still covers after that subtraction is
			// policy, and only policy needs a fresh process.
			return {
				name: params.name,
				rebuildRequired:
					fingerprintPeerDefinition({ ...written, rooms: current.rooms }) !==
					fingerprintPeerDefinition(current),
			};
		},

		task_handoff: async (params): Promise<TaskHandoffResult> => {
			const target = context.peers.get(params.toAgent);
			if (!target) {
				throw new InvalidParamsError(
					"toAgent",
					`Unknown agent: ${params.toAgent}`,
				);
			}
			const source = context.peers.get(params.fromAgent);

			// Hand off in a room the receiver actually reads, preferring one both
			// peers share so the exchange stays visible to the team.
			const shared = source?.rooms.find((room) => target.rooms.includes(room));
			const room = shared ?? target.rooms[0];
			if (room === undefined) {
				throw new InvalidParamsError(
					"toAgent",
					`Agent ${params.toAgent} subscribes to no room to hand off in`,
				);
			}

			const lines = [
				`@${params.toAgent} handoff from @${params.fromAgent}: ${params.summary}`,
			];
			if (params.artifacts && params.artifacts.length > 0) {
				lines.push(`artifacts: ${params.artifacts.join(", ")}`);
			}
			const posted = await post({
				room,
				author: params.fromAgent,
				body: lines.join("\n"),
			});
			return { handoffId: `${room}:${posted.messageId}` };
		},

		schedules_list: async (): Promise<SchedulesListResult> => ({
			schedules: [...context.schedules.values()].map((record) => ({
				id: record.id,
				cron: record.cron,
				action: record.action,
				nextFireAt: record.nextFireAt,
				enabled: record.enabled,
			})),
		}),

		schedules_arm: async (params): Promise<SchedulesArmResult> => {
			const schedule = context.armSchedule(params.scheduleId, params.enabled);
			if (!schedule) {
				throw new InvalidParamsError(
					"scheduleId",
					`Unknown schedule: ${params.scheduleId}`,
				);
			}
			return { schedule };
		},

		/**
		 * Stop a peer and, by default, its whole subtree.
		 *
		 * Cascading is the default because orphanhood is the state this design
		 * refuses to allow (ADR-011): a child left running under a dead parent
		 * answers to nobody. `keep_children` is the explicit opt-out, and it
		 * reparents rather than detaching into limbo.
		 *
		 * `keep_children` is validated here rather than by `METHODS`, which
		 * checks only the fields it declares and passes anything else through
		 * untouched. That is fine for an additive field nobody acts on, and not
		 * fine for this one: the default is destructive, so a value the daemon
		 * cannot read must be refused rather than read as absent. Coercing
		 * `"true"` to "not true" would answer success while killing the exact
		 * children the caller asked to spare.
		 */
		kill: async (params): Promise<KillResult> => {
			const keepChildren =
				"keep_children" in params ? params.keep_children : undefined;
			if (keepChildren !== undefined && typeof keepChildren !== "boolean") {
				throw new InvalidParamsError(
					"keep_children",
					"keep_children must be a boolean when present",
				);
			}

			// The wire result is narrower than the operation's outcome on
			// purpose: `keptChildren`/`cascaded` are what the console renders,
			// and `KillResult` is a published protocol shape this task does not
			// get to widen.
			const { name, state } = await operations.kill(params.name, {
				keepChildren: keepChildren === true,
			});
			return { name, state };
		},

		bump: async (params): Promise<BumpResult> =>
			await operations.bump(params.account, params.budgetUsd),

		/**
		 * Stop the daemon, acknowledging first and closing after.
		 *
		 * `requestDaemonStop` schedules the close instead of awaiting it, so
		 * this returns while the socket is still up and the reply reaches the
		 * caller. Awaiting shutdown here would sever the connection the answer
		 * travels on, and a self-stop that hangs its caller on a dead socket is
		 * indistinguishable from a daemon that wedged.
		 */
		daemon_stop: async (): Promise<DaemonStopResult> => {
			if (!context.requestDaemonStop) {
				throw new InvalidParamsError(
					"params",
					"Daemon shutdown is not available on this daemon",
				);
			}
			return await context.requestDaemonStop();
		},
	};

	const workerMethods: Partial<Record<MethodName, true>> = {
		chat_send: true,
		chat_read: true,
		chat_wait: true,
		chat_react: true,
		chat_unreact: true,
		agent_status: true,
		agent_spawn: true,
		task_handoff: true,
		logs_tail: true,
	};

	/**
	 * The attribution field each method carries, and the reason ADR-014 has
	 * anything to bind: these are the only worker-callable methods whose
	 * payload names who spoke. `task_handoff` belongs here for the same reason
	 * `chat_send` does — it posts into a room under the name it is handed, so
	 * a caller-supplied `fromAgent` is a forgeable author.
	 */
	const ATTRIBUTION_FIELD: Partial<
		Record<MethodName, "author" | "actor" | "fromAgent">
	> = {
		chat_send: "author",
		chat_react: "actor",
		chat_unreact: "actor",
		task_handoff: "fromAgent",
	};

	/**
	 * ADR-014: a worker speaks as itself, whatever its payload claims.
	 *
	 * Overwritten rather than refused. A worker is an LLM that will mislabel
	 * itself sooner or later, and answering `forbidden` turns that into a retry
	 * loop it cannot reason its way out of; rewriting is lossless — the room
	 * still gets the message, under the only name the connection can prove.
	 *
	 * The operator token is exempt, and that exemption is the privilege: it is
	 * the human's own credential, it is what `inject` and `rooms_post` already
	 * use to speak for a peer, and there is no identity above it to bind it to.
	 */
	const bindAttribution = (
		identity: ControlIdentity,
		method: MethodName,
		params: unknown,
	): unknown => {
		if (identity.kind === "operator") return params;
		const field = ATTRIBUTION_FIELD[method];
		if (field === undefined) return params;
		if (typeof params !== "object" || params === null) return params;
		return { ...params, [field]: identity.peerName };
	};

	const authorize = (
		id: JsonRpcId,
		identity: ControlIdentity,
		method: MethodName,
		params: unknown,
	): JsonRpcFailure | undefined => {
		if (identity.kind === "operator") return undefined;
		if (workerMethods[method] !== true) {
			// ADR-012 (a): in remote mode the operator surface is reachable
			// only with the operator token, so a worker bearer here has not
			// presented the credential this surface authenticates against —
			// the declared `unauthorized` shape, the same one a missing or
			// unregistered bearer gets, rather than the `forbidden` that means
			// "registered caller, out of scope". The worker surface below is
			// untouched in both modes, which is clause (b).
			return remoteMode
				? unauthorized(id)
				: forbidden(id, `Workers may not call ${method}`);
		}
		if (
			remoteMode &&
			method === "agent_spawn" &&
			(typeof params !== "object" ||
				params === null ||
				!("parent" in params) ||
				params.parent !== identity.peerName)
		) {
			return forbidden(
				id,
				`Worker ${identity.peerName} may only spawn with itself as parent`,
			);
		}
		if (method === "logs_tail") {
			const named =
				typeof params === "object" && params !== null && "name" in params
					? params.name
					: undefined;
			if (named !== identity.peerName) {
				return forbidden(
					id,
					`Worker ${identity.peerName} may only read its own logs`,
				);
			}
			// The daemon's own stderr carries every peer's activity and the
			// console URL that grants operator access, so the source selector
			// is operator-only even though the method is not — and an
			// operator-only surface is one the operator token is required for,
			// so remote mode refuses a worker bearer here the same way it
			// refuses one on an operator-only method (ADR-012 (a)). The
			// refusal above stays `forbidden` in both modes: reading another
			// worker's logs is scoping within the worker surface, not a fixed
			// operator resource, so clause (a) has nothing to say about it.
			if (
				typeof params === "object" &&
				params !== null &&
				"source" in params &&
				params.source === "daemon"
			) {
				return remoteMode
					? unauthorized(id)
					: forbidden(
							id,
							`Worker ${identity.peerName} may not read the daemon log`,
						);
			}
		}
		return undefined;
	};

	const dispatch = async (
		body: string,
		identity: ControlIdentity,
	): Promise<Response> => {
		let frame: unknown;
		try {
			frame = JSON.parse(body);
		} catch {
			return Response.json(
				failure(0, ERROR_CODE.PARSE_ERROR, "Request body is not valid JSON"),
			);
		}

		if (typeof frame !== "object" || frame === null || !("method" in frame)) {
			return Response.json(
				failure(0, ERROR_CODE.PARSE_ERROR, "Request frame declares no method"),
			);
		}

		const id =
			"id" in frame &&
			(typeof frame.id === "number" || typeof frame.id === "string")
				? frame.id
				: 0;
		const method = String(frame.method);
		if (!(method in handlers)) return Response.json(methodNotFound(id, method));
		const name = method as MethodName;

		const params = "params" in frame ? frame.params : undefined;
		const validated = METHODS[name].validateParams(params ?? {});
		if (!validated.ok) {
			return Response.json(
				invalidParams(id, validated.field, validated.message),
			);
		}

		// `definition_update`'s validator returns the validated `changes` object
		// rather than the whole params frame, so the `name` it checked is not in
		// what it hands back. Restore it from the request: the handler needs the
		// peer's name, and the alternative is reading `undefined` and answering
		// "Unknown peer: undefined" for every well-formed update.
		const value =
			name === "definition_update" &&
			typeof params === "object" &&
			params !== null &&
			"name" in params
				? { name: params.name, changes: validated.value }
				: validated.value;

		const denied = authorize(id, identity, name, value);
		if (denied) return Response.json(denied);

		// Bound after authorization, so a refusal is still decided on what the
		// caller actually sent, and before the handler, so nothing downstream
		// ever sees the claimed attribution.
		const bound = bindAttribution(identity, name, value);

		// One cast, at the validated boundary: `METHODS[name]` has just proven the
		// payload matches this method's params, but the registry's return type is
		// method-agnostic, so the compiler cannot pair them up on its own.
		const handler = handlers[name] as (params: unknown) => Promise<unknown>;

		try {
			return Response.json({
				jsonrpc: "2.0",
				id,
				result: await handler(bound),
			});
		} catch (error) {
			if (error instanceof InvalidParamsError) {
				return Response.json(invalidParams(id, error.field, error.message));
			}
			return Response.json(
				failure(
					id,
					ERROR_CODE.INTERNAL_ERROR,
					error instanceof Error ? error.message : String(error),
				),
			);
		}
	};

	// `Bun.serve`'s unix variant omits `idleTimeout` from its type while the
	// runtime honors it (verified on Bun 1.3.14: a 14s response completes with
	// `idleTimeout: 0` and is severed at ~10s without it). A parked `chat_wait`
	// runs far past the default, so the option is required and the cast is the
	// narrowest way to pass it.
	const serveOptions = {
		unix: socketPath,
		idleTimeout: 0,
		fetch: async (request: Request): Promise<Response> => {
			if (request.method !== "POST") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			const authorization = request.headers.get("Authorization");
			const token = authorization?.startsWith("Bearer ")
				? authorization.slice("Bearer ".length)
				: undefined;
			// Constant-time: a `Map` lookup is a hash and a key comparison that
			// stops at the first differing byte, so its timing is a function of
			// how much of a valid bearer the caller already has. Every
			// registered credential is compared, and the loop does not break on
			// a hit, so the work is the same whether the token matches the
			// first entry, the last, or none (ADR-012).
			let identity: ControlIdentity | undefined;
			if (token !== undefined) {
				for (const [candidate, registered] of identities) {
					if (tokenMatches(token, candidate)) identity = registered;
				}
			}
			if (identity === undefined) {
				return Response.json(unauthorized(0));
			}
			if (!remoteMode || audit === undefined) {
				return await dispatch(await request.text(), identity);
			}
			const auditConnection = await audit.connect(
				identity.kind === "operator" ? "operator" : identity.peerName,
				"control-socket",
				socketPath,
			);
			if (auditConnection === undefined) {
				// A JSON-RPC caller — the CLI included — parses every reply as
				// JSON-RPC. A bare-text body here would surface a saturated audit
				// as a parser complaint about JSON, hiding the one reason an
				// operator needs at exactly the moment they run `omp-agent audit`.
				// `id` is 0 because the refusal precedes `request.text()`, so the
				// caller's id was never parsed — the same reason the parse
				// refusals above use 0.
				return Response.json(
					failure(
						0,
						ERROR_CODE.UNAVAILABLE,
						"Connection audit capacity reached",
					),
					{ status: 503 },
				);
			}
			try {
				return await dispatch(await request.text(), identity);
			} finally {
				await audit.disconnect(auditConnection);
			}
		},
		// Cast: the unix variant's type pins `idleTimeout` to `undefined`, so the
		// supported runtime option is unexpressible without going through unknown.
	} as unknown as Bun.Serve.Options<undefined>;

	const server = Bun.serve(serveOptions);

	return {
		socketPath,
		close: async () => {
			if (closing) return;
			// Flip first: a parked `chat_wait` observes this within one poll
			// interval and returns, so `server.stop(true)` has no long-lived
			// in-flight request to wait out.
			closing = true;
			auditRecorders.delete(operations);
			server.stop(true);
		},
	};
}
