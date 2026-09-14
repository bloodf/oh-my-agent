/** The daemon's error envelope and a tiny route table. */

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export const fail = (status: number, code: string, message: string): never => {
	throw new HttpError(status, code, message);
};

export type ApiResult = { status: number; body: unknown };

export type RouteContext = {
	method: string;
	url: URL;
	params: string[];
	body: Record<string, unknown> | undefined;
	headers: Record<string, string>;
};

export type Route = {
	method: string;
	pattern: RegExp;
	handle: (ctx: RouteContext) => ApiResult | Promise<ApiResult>;
};

export const ok = (body: unknown, status = 200): ApiResult => ({ status, body });

export const route = (method: string, pattern: RegExp, handle: Route["handle"]): Route => ({
	method,
	pattern,
	handle,
});

export function decode(value: string | undefined): string {
	try {
		return decodeURIComponent(value ?? "");
	} catch {
		return fail(400, "invalid_request", `Malformed escape in ${value}`);
	}
}

export function requireBody(ctx: RouteContext): Record<string, unknown> {
	return ctx.body ?? fail(400, "invalid_request", "Body is not valid JSON");
}
