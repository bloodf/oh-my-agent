export const AUTHENTICATION_REQUIRED = new Error(
	"Operator authentication required",
);

const TOKEN_STORAGE_KEY = "oh-my-agent.operator-token";

export function readToken(): { token: string; remoteMode: boolean } {
	const params = new URLSearchParams(location.search);
	const remoteMode = document.documentElement.dataset.authMode === "remote";
	// A loopback token arrives once, in the URL, and is kept in session
	// storage from then on — the same place remote mode keeps it. This is
	// called on every request, and the address bar is stripped below after
	// the first read, so reading the URL alone would hand every later call an
	// empty token.
	const fromUrl = remoteMode ? null : params.get("token");
	if (fromUrl) sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
	const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
	// Strip the credential from the address bar once it has been read, in both
	// modes. Loopback used to leave `?token=` there for the life of the tab —
	// in history, session restore, and anything that later reads the URL.
	const credential = remoteMode ? "ticket" : "token";
	if (params.has(credential)) {
		params.delete(credential);
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
