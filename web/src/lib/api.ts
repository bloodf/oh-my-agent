export const AUTHENTICATION_REQUIRED = new Error(
	"Operator authentication required",
);

/**
 * A refused API call. `message` is what the daemon said, or the HTTP status
 * when it said nothing readable; `code` is the daemon's error code, so a
 * caller can branch on `error.code === "PLAN_REVISION_CONFLICT"` instead of
 * matching message text.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export async function api(
	path: string,
	init: {
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
		token: string;
		remoteMode: boolean;
		onUnauthorized: () => void;
	},
): Promise<Record<string, unknown>> {
	const response = await fetch(path, {
		method: init.method ?? "GET",
		headers: {
			"X-Operator-Token": init.token,
			...(init.body === undefined
				? {}
				: { "content-type": "application/json" }),
			...init.headers,
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
	// A refused token means the same thing in both modes: loopback sees it
	// when the daemon restarted with a rotated token.
	if (response.status === 401) {
		init.onUnauthorized();
		throw AUTHENTICATION_REQUIRED;
	}
	const text = await response.text();
	let payload: unknown;
	try {
		payload = text === "" ? {} : JSON.parse(text);
	} catch {
		payload = undefined;
	}
	if (!response.ok) {
		const detail =
			payload && typeof payload === "object" && "error" in payload
				? (payload as { error?: { code?: unknown; message?: unknown } }).error
				: undefined;
		throw new ApiError(
			typeof detail?.message === "string"
				? detail.message
				: `HTTP ${response.status}`,
			response.status,
			typeof detail?.code === "string" ? detail.code : undefined,
		);
	}
	if (payload === undefined || payload === null || typeof payload !== "object")
		throw new ApiError(
			`Unreadable response: HTTP ${response.status}`,
			response.status,
		);
	return payload as Record<string, unknown>;
}
