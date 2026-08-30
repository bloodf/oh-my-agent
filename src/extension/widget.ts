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
 *
 * Failure modes: an absent socket raises `DaemonUnavailableError`, which
 * every command renders as one plain sentence. A protocol failure frame
 * raises with the server's message, so the operator sees the daemon's reason
 * rather than a client-side guess.
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
import { METHODS } from "../shared/protocol-schemas";
import type { DaemonClient, ExtensionIO } from "./commands";
import { DaemonUnavailableError } from "./commands";

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
			let response: Response;
			try {
				nextId += 1;
				const token = (
					await readFile(join(dirname(socketPath), "console-token"), "utf8")
				).trim();
				response = await fetch("http://localhost/rpc", {
					unix: socketPath,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
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

		// A zero-timeout wait returns the backlog across every known room
		// without parking; the operator has no read cursor, so every backlog
		// message is "unread" from the TUI's side.
		const { messages } = await client.call<ChatWaitResult>("chat_wait", {
			sinceId: 0,
			timeoutMs: 0,
		});

		io.setWidget(WIDGET_KEY, [
			`agents: ${running} running, ${parked} parked · rooms: ${messages.length} unread`,
		]);
	} catch (error) {
		io.setWidget(WIDGET_KEY, [
			error instanceof DaemonUnavailableError
				? DAEMON_UNAVAILABLE
				: `daemon error: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
}
