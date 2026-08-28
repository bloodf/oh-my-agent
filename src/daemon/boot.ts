/**
 * Purpose: Decide how the daemon reaches an auth broker at boot (§9.6) —
 * reuse one the user already runs, or embed one over the shared vault — and
 * take custody of the admin token that fronts it.
 *
 * Public API: `resolveBrokerHosting(options): Promise<BrokerHosting>`.
 *
 * Upstream deps: `@oh-my-pi/pi-ai` (`AuthStorage`, `SqliteAuthCredentialStore`),
 * `@oh-my-pi/pi-ai/auth-broker` (`startAuthBroker`).
 *
 * Downstream consumers: the credential gateway, which fronts this hosting with
 * per-worker scoped tokens. Workers never see `adminToken`.
 *
 * Failure modes: a configured-but-unreachable broker, or a token the broker
 * rejects, fails boot rather than silently falling back to an embedded broker —
 * a silent fallback would split credentials across two vaults.
 *
 * Performance: one health probe plus one authenticated probe per boot.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker/discover";

export interface ResolveBrokerHostingOptions {
	/** Agent dir holding `config.yml` and, when embedding, the shared vault. */
	agentDir: string;
	/** Environment consulted for `OMP_AUTH_BROKER_URL` / `_TOKEN`. */
	env: Record<string, string | undefined>;
}

export interface BrokerHosting {
	/** `external` reuses a discovered broker; `embedded` is daemon-owned. */
	mode: "external" | "embedded";
	url: string;
	/**
	 * Bearer fronting the broker. Read-only and never rotated when external,
	 * freshly generated in memory when embedded. Never handed to a worker —
	 * workers get per-worker gateway tokens instead.
	 */
	adminToken: string;
	/** Stops an embedded broker. A no-op for a broker the daemon does not own. */
	close(): Promise<void>;
}

/**
 * Run OMP's own client discovery chain (env -> `auth.broker.*` in the agent
 * dir's config -> config-root token file, with `!command` indirection) so the
 * daemon reuses exactly the broker a plain OMP session would.
 *
 * `resolveAuthBrokerConfig` reads `process.env` directly, so an explicit `env`
 * override is applied around the call rather than passed through.
 */
async function discoverBrokerConfig(
	agentDir: string,
	env: Record<string, string | undefined>,
): Promise<{ url: string; token: string } | null> {
	const keys = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;
	const saved = keys.map((key) => [key, process.env[key]] as const);
	for (const key of keys) {
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await resolveAuthBrokerConfig({ agentDir });
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * Prove the discovered broker is both reachable and willing to accept the
 * token before the daemon commits to it. A daemon that discovers a broker it
 * cannot authenticate against must fail loudly: falling back to an embedded
 * broker would strand every credential the user expected to share.
 */
async function probeBroker(url: string, token: string): Promise<void> {
	const health = await fetch(`${url}/v1/healthz`);
	if (!health.ok)
		throw new Error(`Auth broker at ${url} is unhealthy: ${health.status}`);

	const snapshot = await fetch(`${url}/v1/snapshot`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (snapshot.status === 401 || snapshot.status === 403) {
		throw new Error(
			`Auth broker at ${url} rejected the configured token: ${snapshot.status}`,
		);
	}
	if (!snapshot.ok)
		throw new Error(`Auth broker at ${url} returned ${snapshot.status}`);
}

export async function resolveBrokerHosting(
	options: ResolveBrokerHostingOptions,
): Promise<BrokerHosting> {
	const { agentDir, env } = options;

	const discovered = await discoverBrokerConfig(agentDir, env);
	if (discovered) {
		await probeBroker(discovered.url, discovered.token);
		return {
			mode: "external",
			url: discovered.url,
			adminToken: discovered.token,
			// The daemon does not own this broker: closing must not stop it.
			close: async () => {},
		};
	}

	// Embedded: fresh admin token per boot, held in memory only.
	const adminToken = randomBytes(32).toString("base64url");
	const store = await SqliteAuthCredentialStore.open(join(agentDir, "auth.db"));
	const storage = new AuthStorage(store);
	await storage.reload();

	const handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [adminToken],
		version: "oh-my-agent",
	});

	let closed = false;
	return {
		mode: "embedded",
		url: handle.url,
		adminToken,
		close: async () => {
			if (closed) return;
			closed = true;
			await handle.close();
			storage.close();
		},
	};
}
