/**
 * Purpose: One construction seam for authenticated daemon-socket calls in
 * tests, per ADR-008 (production builders, never a parallel copy). The token
 * the daemon mints at boot lives in `<stateDir>/console-token`; the live
 * control socket answers only requests that present it as
 * `Authorization: Bearer <token>`. Tests boot the daemon against a temp
 * agent dir, read the token once, and thread it through every caller rather
 * than rebuilding a raw `fetch` per suite.
 *
 * Public API: `operatorToken(stateDir)`, `controlClient(socketPath, token)`.
 *
 * Upstream deps: `node:fs/promises`, `node:path`.
 * Downstream consumers: every test that talks to a booted daemon or a
 * harness-started control socket.
 *
 * Failure modes: a missing token file throws `Error` (the suite will then
 * fail with a clear message rather than getting a confusing 401 from a
 * live daemon). `controlClient` rejects on connection failure, which the
 * suite's own callers map to `DaemonUnavailableError` semantics where it
 * matters.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Read the operator token the daemon minted at boot. */
export async function operatorToken(stateDir: string): Promise<string> {
	return (await readFile(join(stateDir, "console-token"), "utf8")).trim();
}

/**
 * The fixed bearer harness-started `startControlSocket` instances accept.
 * `bootDaemon` mints its own token to `<stateDir>/console-token` and is read
 * with `operatorToken(stateDir)`; this constant is the one a `startControlSocket`
 * test harness hands to `operatorIdentities` so every local call can present
 * the matching `Authorization: Bearer …` header through `controlCall`.
 */
export const TEST_OPERATOR_TOKEN = "test-operator";

/**
 * The identity map a `startControlSocket` harness installs so its own calls —
 * and the `createDaemonClient` widget, which reads `console-token` from the
 * socket's parent dir — pass bearer auth against the fixture's chosen token.
 */
export function operatorIdentities(
	token: string = TEST_OPERATOR_TOKEN,
): ReadonlyMap<string, import("../../src/daemon/socket").ControlIdentity> {
	return new Map([[token, { kind: "operator" }]]);
}

/**
 * One JSON-RPC round trip over the daemon's unix socket, presenting the
 * operator bearer. Returns the parsed frame so a suite can decide between a
 * success and a `code: -32001 Unauthorized` reply the way it always has.
 */
export async function controlCall(
	socketPath: string,
	method: string,
	params: unknown,
	token: string,
	id: number | string = 1,
): Promise<unknown> {
	const response = await fetch("http://localhost/rpc", {
		unix: socketPath,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	return await response.json();
}
