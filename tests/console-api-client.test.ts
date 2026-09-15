/**
 * The browser console's API helper: how a daemon answer becomes a value, an
 * error a caller can branch on, or the token prompt.
 *
 * The helper is the production module under `web/src/lib/api.ts`; `fetch` is
 * replaced for each case with a server that answers one fixed way.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";

import { ApiError, AUTHENTICATION_REQUIRED, api } from "../web/src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Answer every fetch with this response, and count the unauthorized calls. */
function answer(response: () => Response) {
	globalThis.fetch = (async () => response()) as unknown as typeof fetch;
	let unauthorized = 0;
	const call = (remoteMode: boolean) =>
		api("/api/anything", {
			token: "operator-token",
			remoteMode,
			onUnauthorized: () => {
				unauthorized += 1;
			},
		});
	return { call, unauthorized: () => unauthorized };
}

describe("api()", () => {
	test("a refused call keeps the daemon's message and exposes its code and status", async () => {
		const server = answer(() =>
			Response.json(
				{
					error: {
						code: "PLAN_REVISION_CONFLICT",
						message: "Plan changed since you loaded it",
					},
				},
				{ status: 409 },
			),
		);
		const error = await server.call(false).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			message: "Plan changed since you loaded it",
			code: "PLAN_REVISION_CONFLICT",
			status: 409,
		});
	});

	test("a non-JSON error body reports the HTTP status, not a parse error", async () => {
		const server = answer(
			() => new Response("<html>Bad Gateway</html>", { status: 502 }),
		);
		const error = await server.call(false).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			message: "HTTP 502",
			status: 502,
			code: undefined,
		});
	});

	test("an empty success, such as a 204 delete, resolves to an empty object", async () => {
		const server = answer(() => new Response(null, { status: 204 }));
		expect(await server.call(false)).toEqual({});
	});

	test("a 401 asks for the token in loopback mode as well as remote mode", async () => {
		for (const remoteMode of [false, true]) {
			const server = answer(() =>
				Response.json(
					{
						error: { code: "unauthorized", message: "Operator token required" },
					},
					{ status: 401 },
				),
			);
			const error = await server.call(remoteMode).catch((cause) => cause);
			expect(error).toBe(AUTHENTICATION_REQUIRED);
			expect(`remoteMode=${remoteMode}: ${server.unauthorized()}`).toBe(
				`remoteMode=${remoteMode}: 1`,
			);
		}
	});
});
