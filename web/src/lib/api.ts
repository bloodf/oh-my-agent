export const AUTHENTICATION_REQUIRED = new Error(
	"Operator authentication required",
);

export function readToken(): { token: string; remoteMode: boolean } {
	const params = new URLSearchParams(location.search);
	const remoteMode = document.documentElement.dataset.authMode === "remote";
	const token = remoteMode
		? (sessionStorage.getItem("oh-my-agent.operator-token") ?? "")
		: (params.get("token") ?? "");
	if (remoteMode && params.has("ticket")) {
		params.delete("ticket");
		history.replaceState(
			null,
			"",
			`${location.pathname}${params.size > 0 ? `?${params}` : ""}${location.hash}`,
		);
	}
	return { token, remoteMode };
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
	if (init.remoteMode && response.status === 401) {
		init.onUnauthorized();
		throw AUTHENTICATION_REQUIRED;
	}
	const payload = await response.json();
	if (!response.ok) {
		const detail =
			payload && typeof payload === "object" && "error" in payload
				? (payload as { error?: { message?: string } }).error
				: undefined;
		throw new Error(
			typeof detail?.message === "string"
				? detail.message
				: `HTTP ${response.status}`,
		);
	}
	return payload as Record<string, unknown>;
}
