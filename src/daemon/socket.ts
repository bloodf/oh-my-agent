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
 * Performance: one dispatch per request. `chat_wait` parks on a polling loop
 * whose sleeps are woken by `close()`, so shutdown never waits out a long poll.
 */
import type { RoomStore, RoomMessage as StoredMessage } from "../rooms/store";
import type {
	AgentSpawnParams,
	AgentSpawnResult,
	AgentStatus,
	AgentStatusParams,
	AgentStatusResult,
	BumpParams,
	BumpResult,
	ChatReadParams,
	ChatReadResult,
	ChatSendParams,
	ChatSendResult,
	ChatWaitParams,
	ChatWaitResult,
	JsonRpcFailure,
	JsonRpcId,
	KillParams,
	KillResult,
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
import type { SupervisedWorker, Supervisor } from "./supervisor";

/** Default ceiling for a parked `chat_wait`, per T-507's payload contract. */
const DEFAULT_WAIT_MS = 30_000;

/** How often a parked wait re-reads the room. Woken early on close. */
const WAIT_POLL_MS = 50;

/** Author recorded for a post that names none: the human at the keyboard. */
export const HUMAN_AUTHOR = "@you";

/** A peer the daemon has registered with the supervisor. */
export interface PeerRecord {
	worker: SupervisedWorker & Partial<Pick<WorkerHandle, "sandboxed">>;
	accountId: string;
	model?: string;
	rooms: string[];
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
	startedAt: number;
	now(): number;
	/** Create the room if it does not exist yet, and index it. */
	ensureRoom(id: string): Promise<void>;
	/** Build and register a peer's worker. Rejects an unknown peer name. */
	spawnPeer(name: string): Promise<AgentSpawnResult>;
	/** Enable or disable an armed schedule. Returns undefined when unknown. */
	armSchedule(id: string, enabled: boolean): ScheduleInfo | undefined;
	/** Clear an account's park state. Returns the peers the bump resumed. */
	bumpAccount(accountId: string): Promise<string[]>;
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
	agent_spawn: AgentSpawnParams;
	agent_status: AgentStatusParams;
	task_handoff: TaskHandoffParams;
	rooms_list: RoomsListParams;
	rooms_post: RoomsPostParams;
	schedules_list: SchedulesListParams;
	schedules_arm: SchedulesArmParams;
	kill: KillParams;
	bump: BumpParams;
}

type Handlers = {
	[K in MethodName]: (params: ParamsByMethod[K]) => Promise<unknown>;
};

/** Strip the store's threading and reaction fields down to the wire shape. */
function toWireMessage(message: StoredMessage): RoomMessage {
	return {
		id: message.id,
		room: message.room,
		author: message.author,
		body: message.body,
		createdAt: message.createdAt,
	};
}

function toAgentStatus(name: string, record: PeerRecord): AgentStatus {
	return {
		name,
		state: record.worker.state,
		account: record.accountId,
		...(record.model === undefined ? {} : { model: record.model }),
		sandboxed: record.worker.sandboxed,
	};
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

	const handlers: Handlers = {
		status: async (): Promise<StatusResult> => ({
			protocolVersion: PROTOCOL_VERSION,
			agents: [...context.peers].map(([name, record]) =>
				toAgentStatus(name, record),
			),
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

		rooms_list: async (): Promise<RoomsListResult> => ({
			rooms: [...context.knownRooms.values()],
		}),

		agent_status: async (params): Promise<AgentStatusResult> => {
			if (params.name === undefined) {
				return {
					agents: [...context.peers].map(([peer, record]) =>
						toAgentStatus(peer, record),
					),
				};
			}
			const record = context.peers.get(params.name);
			if (!record) {
				throw new InvalidParamsError("name", `Unknown agent: ${params.name}`);
			}
			return { agents: [toAgentStatus(params.name, record)] };
		},

		agent_spawn: async (params): Promise<AgentSpawnResult> =>
			await context.spawnPeer(params.name),

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

		kill: async (params): Promise<KillResult> => {
			const record = context.peers.get(params.name);
			if (!record) {
				throw new InvalidParamsError("name", `Unknown agent: ${params.name}`);
			}
			await record.worker.stop();
			return { name: params.name, state: "stopped" };
		},

		bump: async (params): Promise<BumpResult> => {
			const resumed = await context.bumpAccount(params.account);
			// The registry tracks a 0..1 meter, not dollars, so the new ceiling is
			// echoed rather than stored: T-506 owns metered budget accounting.
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

		// One cast, at the validated boundary: `METHODS[name]` has just proven the
		// payload matches this method's params, but the registry's return type is
		// method-agnostic, so the compiler cannot pair them up on its own.
		const handler = handlers[name] as (params: unknown) => Promise<unknown>;

		try {
			return Response.json({
				jsonrpc: "2.0",
				id,
				result: await handler(validated.value),
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
