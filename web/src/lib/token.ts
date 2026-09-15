const TOKEN_STORAGE_KEY = "oh-my-agent.operator-token";

export function readToken(): { token: string; remoteMode: boolean } {
	const params = new URLSearchParams(location.search);
	const remoteMode = document.documentElement.dataset.authMode === "remote";
	// A loopback token arrives in the URL on first load and is copied into
	// session storage, where remote mode also keeps it. Later calls read it
	// from there, because the first call strips it from the address bar.
	const fromUrl = remoteMode ? null : params.get("token");
	if (fromUrl) sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
	const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
	// Strip the credential from the address bar once it has been read, in both
	// modes, so it does not sit in history or session restore. A reload still
	// works: the daemon set a static cookie on the first load.
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
