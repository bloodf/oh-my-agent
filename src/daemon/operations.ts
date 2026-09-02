/**
 * Purpose: The four destructive/operator capabilities — kill, inject, logs
 * tail, and budget bump — as one module over the daemon's peer index, so the
 * control socket (T-507) and the console API (T-1605) drive identical
 * behavior instead of each carrying its own copy.
 *
 * Public API: `OperationsContext`, `Operations`, `createOperations`.
 *
 * Upstream deps: `../rooms/store` (the queued-injection post), `./supervisor`
 * (the seam that wakes a peer), `../shared/protocol` (the wire result shapes
 * both surfaces answer with), and a type-only `PeerRecord` from `./socket`.
 * This module owns `HUMAN_AUTHOR` and `InvalidParamsError`, which `./socket`
 * re-exports: `./socket` imports this one for the operations themselves, so
 * holding those values there instead would make the pair a value-level import
 * cycle.
 *
 * Downstream consumers: `./socket`'s `kill`, `inject`, `logs_tail`, and
 * `bump` handlers, and the console API's `/api/agents/:name/{kill,inject,
 * logs}` and `/api/accounts/:id/bump` routes. Composed once in `./main`.
 *
 * Failure modes: every caller-caused refusal is an `InvalidParamsError`
 * naming the offending field, which the socket answers as `invalidParams` and
 * the console maps to 400 (or 404 for an unknown name). Nothing here is
 * idempotent in the harmless sense: `kill` stops workers and `inject` posts a
 * message. `kill` reports *whether* a cascade ran (`cascaded`) and whether
 * children survived (`keptChildren`) rather than naming the peers it stopped,
 * because `killPeer` is optional and the fallback stops the named worker
 * alone — a caller that assumed the subtree died would leave children running
 * under a dead parent.
 *
 * Performance: standard. `logsTail` slices an in-memory buffer; `bump` awaits
 * the supervisor settling the account it resumed.
 */

import type { RoomStore } from "../rooms/store";
import type {
	BumpResult,
	InjectResult,
	KillResult,
	LogsSource,
	LogsTailResult,
} from "../shared/protocol";
import type { PeerRecord } from "./socket";
import type { Supervisor } from "./supervisor";

/** Author recorded for a post that names none: the human at the keyboard. */
export const HUMAN_AUTHOR = "@you";

/**
 * A params failure raised from inside an operation or a protocol handler.
 * Carries the offending field so the control socket's dispatcher answers the
 * declared `invalidParams` shape rather than a generic internal error, and so
 * the console API can map it to 400 or 404.
 *
 * Owned here rather than in `./socket` because both surfaces raise and catch
 * it, and `./socket` imports this module for the operations themselves — the
 * reverse edge would be a runtime cycle between two modules that both need
 * the other's values at module-evaluation time. `./socket` re-exports both
 * names, so every existing importer is unaffected.
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

/** Default line count for one log-tail response. */
export const DEFAULT_LOG_LINES = 50;

/**
 * The slice of the daemon these four operations touch.
 *
 * Deliberately narrower than `DaemonContext`: the console API is handed this
 * and nothing else, so a route cannot reach definitions, schedules, or the
 * daemon's own lifetime through the object it was given to stop a worker
 * with.
 */
export interface OperationsContext {
	rooms: RoomStore;
	supervisor: Supervisor;
	/** Registered peers by name. */
	peers: Map<string, PeerRecord>;
	/**
	 * Stop a peer and, by default, everything under it. `keepChildren`
	 * reparents its children to root instead.
	 *
	 * Optional: a context that wires no tree has no subtree to cascade
	 * through, and `kill` falls back to stopping the named worker alone.
	 */
	killPeer?(name: string, options: { keepChildren: boolean }): Promise<void>;
	/** Raise a metered account's ceiling and resume it. Returns resumed peers. */
	bumpAccount(accountId: string, budgetUsd: number): Promise<string[]>;
	/**
	 * The daemon's own stderr log, most recent lines last. Absent on a context
	 * with no daemon log to read, where the `daemon` source is refused rather
	 * than answered with an empty tail that reads as "nothing was logged".
	 */
	daemonLog?(): Promise<string>;
}

/** What `kill` actually did, beyond the wire result both surfaces answer. */
export interface KillOutcome extends KillResult {
	/**
	 * Whether children were left running deliberately.
	 *
	 * `true` when the caller asked to keep them *or* when no tree is wired,
	 * because in both cases nothing below the named peer was stopped. The
	 * console renders this rather than restating the request: telling an
	 * operator a subtree died when only one worker did is the failure this
	 * field exists to prevent.
	 */
	keptChildren: boolean;
	/** Whether a real cascade ran, i.e. `killPeer` was wired. */
	cascaded: boolean;
}

export interface Operations {
	/**
	 * Stop a peer, cascading through its subtree unless `keepChildren`.
	 *
	 * `keepChildren` is validated by the caller that parsed it; this takes a
	 * boolean and acts on it, because the default is destructive and a value
	 * the daemon cannot read must never be read as absent.
	 */
	kill(name: string, options: { keepChildren: boolean }): Promise<KillOutcome>;
	/**
	 * Prompt a running peer, or queue the message into its first room and
	 * deliver it when the peer is parked.
	 */
	inject(name: string, message: string): Promise<InjectResult>;
	/** A stderr tail, from a worker by default or from the daemon itself. */
	logsTail(options: {
		name: string;
		lines?: number;
		source?: LogsSource;
	}): Promise<LogsTailResult>;
	/** Raise an account's ceiling and report the peers that resumed. */
	bump(accountId: string, budgetUsd: number): Promise<BumpResult>;
}

/**
 * Bind the four operations to one daemon context.
 *
 * A factory rather than free functions taking a context: `main.ts` composes
 * this once and hands the same object to the socket and the console, which is
 * what makes "one source of truth for the destructive paths" structural
 * rather than a convention two call sites have to remember.
 */
export function createOperations(context: OperationsContext): Operations {
	const require = (name: string): PeerRecord => {
		const record = context.peers.get(name);
		if (!record) {
			throw new InvalidParamsError("name", `Unknown agent: ${name}`);
		}
		return record;
	};

	return {
		kill: async (name, options): Promise<KillOutcome> => {
			const record = require(name);

			if (context.killPeer) {
				await context.killPeer(name, { keepChildren: options.keepChildren });
				return {
					name,
					state: "stopped",
					keptChildren: options.keepChildren,
					cascaded: !options.keepChildren,
				};
			}

			// No tree wired into this context: there is no subtree to cascade
			// through, so stopping the named worker is the whole operation —
			// and saying so is the point, because a caller that asked for a
			// cascade did not get one.
			await record.worker.stop();
			return { name, state: "stopped", keptChildren: true, cascaded: false };
		},

		inject: async (name, message): Promise<InjectResult> => {
			const record = require(name);
			if (record.worker.state === "running") {
				await record.worker.prompt(message);
				return { name, queued: false };
			}
			if (record.worker.state !== "parked") {
				throw new InvalidParamsError(
					"name",
					`Agent ${name} is ${record.worker.state}`,
				);
			}
			const room = record.rooms[0];
			if (room === undefined) {
				throw new InvalidParamsError(
					"name",
					`Agent ${name} subscribes to no room for queued injection`,
				);
			}
			await context.rooms.post({
				room,
				author: HUMAN_AUTHOR,
				body: message,
			});
			await context.supervisor.deliver(name);
			return { name, queued: true };
		},

		logsTail: async ({ name, lines, source }): Promise<LogsTailResult> => {
			let text: string;
			if (source === "daemon") {
				if (!context.daemonLog) {
					throw new InvalidParamsError(
						"source",
						"Daemon logs are not available on this daemon",
					);
				}
				text = await context.daemonLog();
			} else {
				text = require(name).worker.stderr?.() ?? "";
			}
			const tail = text
				.replace(/\r\n/g, "\n")
				.replace(/\n$/, "")
				.split("\n")
				.slice(-(lines ?? DEFAULT_LOG_LINES));
			return {
				name,
				lines: tail.length === 1 && tail[0] === "" ? [] : tail,
			};
		},

		bump: async (accountId, budgetUsd): Promise<BumpResult> => {
			const resumed = await context.bumpAccount(accountId, budgetUsd);
			return { account: accountId, budgetUsd, resumed };
		},
	};
}
