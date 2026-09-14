/**
 * One entry point for every mocked `/api/*` request, independent of the
 * browser: `scripts/mock-smoke.mjs` drives it directly.
 */
import { DEMO_PASSWORD } from "./demoPassword";
import { type ApiResult, HttpError, type Route } from "./http";
import { agentRoutes } from "./routes/agents";
import { roomRoutes } from "./routes/rooms";
import { systemRoutes } from "./routes/system";
import { workspaceRoutes } from "./routes/workspace";

export const ROUTES: Route[] = [...systemRoutes, ...roomRoutes, ...agentRoutes, ...workspaceRoutes];

export type ApiRequest = {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: unknown;
};

const reported = new Set<string>();
const error = (status: number, code: string, message: string): ApiResult => ({ status, body: { error: { code, message } } });

export function hasOperatorToken(headers: Record<string, string>): boolean {
	const bearer = headers.authorization?.replace(/^Bearer\s+/i, "");
	return headers["x-operator-token"] === DEMO_PASSWORD || bearer === DEMO_PASSWORD;
}

export async function handleApi(request: ApiRequest): Promise<ApiResult> {
	if (!hasOperatorToken(request.headers)) return error(401, "unauthorized", "Operator token refused");
	const method = request.method.toUpperCase();
	const path = request.url.pathname;
	const matching = ROUTES.filter((candidate) => candidate.pattern.test(path));
	const found = matching.find((candidate) => candidate.method === method);
	if (!found) {
		if (matching.length > 0) return error(405, "method_not_allowed", `${method} not allowed`);
		const key = `${method} ${path}`;
		if (!reported.has(key)) {
			reported.add(key);
			console.debug(`[console demo] no mock for ${key}; answering {}`);
		}
		return { status: 200, body: {} };
	}
	const params = (found.pattern.exec(path) ?? []).slice(1);
	const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : undefined;
	try {
		return await found.handle({ method, url: request.url, params, body, headers: request.headers });
	} catch (cause) {
		if (cause instanceof HttpError) return error(cause.status, cause.code, cause.message);
		return error(500, "internal", cause instanceof Error ? cause.message : String(cause));
	}
}
