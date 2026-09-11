/**
 * Purpose: The daemon socket client and the status widget (§4.5). The widget
 * shows running/parked agent counts and unread room messages; the client is
 * the single wire seam every command in `./commands` shares, so the
 * daemon-absent degradation lives in exactly one place.
 *
 * Public API: `createDaemonClient(socketPath)`, `refreshWidget(client, io)`,
 * `WIDGET_KEY`, `DAEMON_UNAVAILABLE`.
 *
 * Upstream deps: `../shared/protocol` (frames, method names),
 * `./commands` (`DaemonClient`, `ExtensionIO` — imported as types only, so
 * the import graph stays acyclic).
 *
 * Downstream consumers: `./commands`, `./index`, `tests/extension.test.ts`.
 * The live widget line names `/manage` and never includes the console
 * token. It is painted through the host's theme, so its colors and
 * separators are the operator's.
 *
 * Failure modes: an absent socket raises `DaemonUnavailableError`, which
 * every command renders as one plain sentence. A token this process cannot
 * read, or one the daemon refuses, raises `DaemonAuthError` instead — a
 * running daemon that refuses a bearer is not an absent one, and conflating
 * them made `ensureDaemon` spawn a second daemon on every session start. A
 * protocol failure frame raises with the server's message, so the operator
 * sees the daemon's reason rather than a client-side guess.
 *
 * Performance: one round trip per refresh; the unread total comes from a
 * single `chat_wait` with a zero timeout over every known room rather than
 * one read per room.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
	ChatWaitResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	MethodName,
	StatusResult,
} from "../shared/protocol";
import { ERROR_CODE } from "../shared/protocol";
import { METHODS } from "../shared/protocol-schemas";
import type { DaemonClient, ExtensionIO } from "./commands";
import { DaemonAuthError, DaemonUnavailableError } from "./commands";
import type { TuiTheme } from "./theme";

/** Widget slot the extension refreshes. */
export const WIDGET_KEY = "oh-my-agent";

/** The sentence every surface shares when the socket is absent. */
export const DAEMON_UNAVAILABLE =
	"oh-my-agent daemon not running — start it with `omp-agent daemon`.";

/**
 * The T-507 client shape: one JSON-RPC round trip over the daemon's unix
 * socket via Bun's `fetch(url, { unix })`, the pattern
 * tests/daemon-main.test.ts pins.
 */
export function createDaemonClient(socketPath: string): DaemonClient {
	let nextId = 0;
	const tokenPath = join(dirname(socketPath), "console-token");
	return {
		async call<T>(method: MethodName, params?: unknown): Promise<T> {
			const contract = METHODS[method];
			const outgoing = params ?? {};
			const paramsCheck = contract.validateParams(outgoing);
			if (!paramsCheck.ok) {
				throw new Error(
					`invalid ${method} params at ${paramsCheck.field}: ${paramsCheck.message}`,
				);
			}
			// Read outside the `try` below, and never as a reason to call the
			// daemon absent: a token this process cannot read says nothing about
			// whether the socket is live, and answering "not running" for it is
			// what made `ensureDaemon` spawn a second daemon against a healthy
			// one. An absent file calls unauthenticated and lets the daemon give
			// its own verdict, which is the only authority on the credential.
			let token: string | undefined;
			try {
				token = (await readFile(tokenPath, "utf8")).trim();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw new DaemonAuthError(tokenPath);
				}
			}
			let response: Response;
			try {
				nextId += 1;
				response = await fetch("http://localhost/rpc", {
					unix: socketPath,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token === undefined
							? {}
							: { Authorization: `Bearer ${token}` }),
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: nextId,
						method,
						params: outgoing,
					}),
				});
			} catch {
				// Bun's unix fetch rejects when the socket is missing or refuses
				// the connection; both mean the same thing to the operator.
				throw new DaemonUnavailableError();
			}
			const frame = (await response.json()) as JsonRpcSuccess | JsonRpcFailure;
			if ("error" in frame) {
				if (frame.error.code === ERROR_CODE.UNAUTHORIZED) {
					throw new DaemonAuthError(tokenPath);
				}
				throw new Error(frame.error.message);
			}
			const resultCheck = contract.validateResult(frame.result);
			if (!resultCheck.ok) {
				throw new Error(
					`invalid ${method} result at ${resultCheck.field}: ${resultCheck.message}`,
				);
			}
			return resultCheck.value as T;
		},
	};
}

interface UnreadCursor {
	lastId: number | undefined;
	count: number;
}

/**
 * Each client's read cursor over the room bus.
 *
 * The daemon keeps no read state for the operator, so the count the widget
 * shows has to be tracked on this side. Keyed by client rather than held as
 * one module value because message ids are per-daemon: a cursor shared across
 * two clients would carry one daemon's ids into the other's id space and
 * report nonsense. Weak so a discarded client takes its cursor with it.
 *
 * `lastId` is undefined until the first refresh; a bare `chat_wait` sets the
 * baseline to "anything after now" on the daemon side, which is what makes
 * the first paint zero rather than the entire history of every room.
 */
const unreadCursors = new WeakMap<DaemonClient, UnreadCursor>();

function cursorFor(client: DaemonClient): UnreadCursor {
	const existing = unreadCursors.get(client);
	if (existing) return existing;
	const fresh: UnreadCursor = { lastId: undefined, count: 0 };
	unreadCursors.set(client, fresh);
	return fresh;
}

/**
 * Clear the unread count after the operator reads a transcript.
 *
 * `/rooms read` is the only surface in the TUI that shows message bodies, so
 * it is the only thing that can honestly zero the counter.
 */
export function markRoomsRead(client: DaemonClient): void {
	cursorFor(client).count = 0;
}

/** Refresh the status widget from the daemon, or report its absence. */
export async function refreshWidget(
	client: DaemonClient,
	io: ExtensionIO,
): Promise<void> {
	try {
		const status = await client.call<StatusResult>("status", {});
		const running = status.agents.filter(
			(agent) => agent.state === "running",
		).length;
		const parked = status.agents.filter(
			(agent) => agent.state === "parked",
		).length;

		// A zero-timeout wait returns whatever landed after the cursor without
		// parking. `sinceId` is omitted on the first call so the daemon sets the
		// baseline to the latest id: passing 0 asks for every message in every
		// room, which shipped the whole transcript over the socket after every
		// single turn and made the count grow forever instead of tracking what
		// the operator has not seen.
		const cursor = cursorFor(client);
		const { messages, latestId } = await client.call<ChatWaitResult>(
			"chat_wait",
			{
				...(cursor.lastId === undefined ? {} : { sinceId: cursor.lastId }),
				timeoutMs: 0,
			},
		);
		// `latestId` advances the cursor even on an idle wait, which is the
		// whole reason the daemon reports it: without it an empty result leaves
		// the cursor unset, every later refresh asks for "after now" again, and
		// the count never moves off zero. A daemon too old to send it falls
		// back to the last message seen.
		const latest = latestId ?? messages.at(-1)?.id;
		if (latest !== undefined) cursor.lastId = latest;
		cursor.count += messages.length;

		const unread = cursor.count;
		io.setWidget(WIDGET_KEY, (t: TuiTheme) => {
			const dot = t.fg("dim", ` ${t.sep.dot} `);
			const count = (n: number, color: "success" | "warning" | "accent") =>
				n === 0 ? t.fg("muted", String(n)) : t.bold(t.fg(color, String(n)));
			return [
				[
					t.bold(t.fg("accent", "oh-my-agent")),
					`${count(running, "success")} running`,
					`${count(parked, "warning")} parked`,
					`${count(unread, "accent")} unread`,
					t.fg("dim", "/manage"),
				].join(dot),
			];
		});
	} catch (error) {
		const message =
			error instanceof DaemonUnavailableError
				? DAEMON_UNAVAILABLE
				: `daemon error: ${error instanceof Error ? error.message : String(error)}`;
		io.setWidget(WIDGET_KEY, (t: TuiTheme) => [
			`${t.fg("error", t.status.error)} ${t.fg("warning", message)}`,
		]);
	}
}
