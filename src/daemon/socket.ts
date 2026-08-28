/**
 * Purpose: Serve the T-507 control protocol over the daemon's unix socket
 * (§4.1) — the single surface the TUI, the worker toolbelt, and the web console
 * reach the daemon through, so none of them touches daemon state or the
 * database directly.
 *
 * Public API: `startControlSocket(options): Promise<ControlSocket>`, the
 * `DaemonContext` a composed daemon supplies, and `InvalidParamsError`.
 *
 * Upstream deps: `../shared/protocol` (frames, error builders, version),
 * `../shared/protocol-schemas` (`METHODS`), `../rooms/store`,
 * `../worker/lifecycle` (sandbox state), and `./supervisor`.
 *
 * Downstream consumers: `./main`, which owns composition and lifetime; every
 * operator client speaks to this socket rather than to those objects.
 *
 * Failure modes: protocol problems are data, never exceptions — an unknown
 * method answers `methodNotFound`, malformed params answer `invalidParams` with
 * the offending field, and an unparseable body answers a parse error. All three
 * carry `protocolVersion`. A handler that throws answers an internal error
 * rather than killing the server.
 *
 * Performance: one dispatch per request. `chat_wait` parks on a polling loop;
 * reaction state checks scan public message listings across known rooms.
 * `close()` wakes polling sleeps so shutdown never waits out a long poll.
 */
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
	invalidParams,
	methodNotFound,
	PROTOCOL_VERSION,
} from "../shared/protocol";
import { METHODS } from "../shared/protocol-schemas";
import type { WorkerHandle } from "../worker/lifecycle";
import type { PeerDefinitionFields, PeerStore } from "./peer-store";
import type { SupervisedWorker, Supervisor } from "./supervisor";

/** Default line count for one log-tail response. */
const DEFAULT_LOG_LINES = 50;

/** Default ceiling for a parked `chat_wait`, per T-507's payload contract. */
const DEFAULT_WAIT_MS = 30_000;

/** How often a parked wait re-reads the room. Woken early on close. */
const WAIT_POLL_MS = 50;

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

/** Author recorded for a post that names none: the human at the keyboard. */
export const HUMAN_AUTHOR = "@you";

/** A peer the daemon has registered with the supervisor. */
export interface PeerRecord {
	worker: SupervisedWorker &
		Partial<Pick<WorkerHandle, "sandboxed" | "stderr">>;
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
}

export interface ControlSocket {
	socketPath: string;
	close(): Promise<void>;
}

export interface StartControlSocketOptions {
	socketPath: string;
	context: DaemonContext;
}

/**
 * A params failure raised from inside a handler. Carries the offending field so
 * the dispatcher answers the declared `invalidParams` shape rather than a
 * generic internal error.
 */
export class InvalidParamsError extends Error {
	constructor(
		readonly field: string,
		message: string,
	) {
		super(message);
		this.name = "InvalidParamsError";
	}
}

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
}

type Handlers = {
	[K in MethodName]: (params: ParamsByMethod[K]) => Promise<unknown>;
};

/** Preserve additive threading and reaction metadata on the wire. */
function toWireMessage(message: StoredMessage): RoomMessage {
	return {
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

export async function startControlSocket(
	options: StartControlSocketOptions,
): Promise<ControlSocket> {
	const { socketPath, context } = options;

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

	const hasReaction = async (params: ChatReactionParams): Promise<boolean> => {
		for (const room of context.knownRooms.keys()) {
			const message = (await context.rooms.listMessages(room, {})).find(
				(candidate) => candidate.id === params.messageId,
			);
			if (message) {
				return message.reactions.some(
					(reaction) =>
						reaction.actor === params.actor && reaction.emoji === params.emoji,
				);
			}
		}
		return false;
	};

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
				const removed = await hasReaction(params);
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

		logs_tail: async (params): Promise<LogsTailResult> => {
			const record = context.peers.get(params.name);
			if (!record) {
				throw new InvalidParamsError("name", `Unknown agent: ${params.name}`);
			}
			const lines = (record.worker.stderr?.() ?? "")
				.replace(/\r\n/g, "\n")
				.replace(/\n$/, "")
				.split("\n")
				.slice(-(params.lines ?? DEFAULT_LOG_LINES));
			return {
				name: params.name,
				lines: lines.length === 1 && lines[0] === "" ? [] : lines,
			};
		},

		inject: async (params): Promise<InjectResult> => {
			const record = context.peers.get(params.name);
			if (!record) {
				throw new InvalidParamsError("name", `Unknown agent: ${params.name}`);
			}
			if (record.worker.state === "running") {
				await record.worker.prompt(params.message);
				return { name: params.name, queued: false };
			}
			if (record.worker.state !== "parked") {
				throw new InvalidParamsError(
					"name",
					`Agent ${params.name} is ${record.worker.state}`,
				);
			}
			const room = record.rooms[0];
			if (room === undefined) {
				throw new InvalidParamsError(
					"name",
					`Agent ${params.name} subscribes to no room for queued injection`,
				);
			}
			await context.rooms.post({
				room,
				author: HUMAN_AUTHOR,
				body: params.message,
			});
			await context.supervisor.deliver(params.name);
			return { name: params.name, queued: true };
		},

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
			const record = context.peers.get(params.name);
			if (!record) {
				throw new InvalidParamsError("name", `Unknown agent: ${params.name}`);
			}

			const keepChildren =
				"keep_children" in params ? params.keep_children : undefined;
			if (keepChildren !== undefined && typeof keepChildren !== "boolean") {
				throw new InvalidParamsError(
					"keep_children",
					"keep_children must be a boolean when present",
				);
			}

			if (context.killPeer) {
				await context.killPeer(params.name, {
					keepChildren: keepChildren === true,
				});
			} else {
				// No tree wired into this context: there is no subtree to cascade
				// through, so stopping the named worker is the whole operation.
				await record.worker.stop();
			}
			return { name: params.name, state: "stopped" };
		},

		bump: async (params): Promise<BumpResult> => {
			const resumed = await context.bumpAccount(
				params.account,
				params.budgetUsd,
			);
			return {
				account: params.account,
				budgetUsd: params.budgetUsd,
				resumed,
			};
		},
	};

	const dispatch = async (body: string): Promise<Response> => {
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

		// One cast, at the validated boundary: `METHODS[name]` has just proven the
		// payload matches this method's params, but the registry's return type is
		// method-agnostic, so the compiler cannot pair them up on its own.
		const handler = handlers[name] as (params: unknown) => Promise<unknown>;

		try {
			return Response.json({
				jsonrpc: "2.0",
				id,
				result: await handler(value),
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
			return await dispatch(await request.text());
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
			server.stop(true);
		},
	};
}
