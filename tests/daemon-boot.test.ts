/**
 * RED tests for src/daemon/boot.ts
 *
 * Public API under test: resolveBrokerHosting(options) -> BrokerHosting
 *
 * Architecture contract (§9.6): at boot the daemon runs OMP's client discovery
 * chain (OMP_AUTH_BROKER_URL env -> auth.broker.* in <agentDir>/config.yml ->
 * token file). Admin-token custody differs by mode:
 *
 *   external broker reused -> authenticate with the discovered token, treat it
 *   read-only, never rotate it, never write it anywhere.
 *
 *   embedded -> start the broker over the shared vault with a fresh admin token
 *   generated at boot and held in memory only.
 *
 * Either way the resolved hosting must be reachable before the daemon proceeds,
 * and the admin token must never be handed to a worker.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type { BrokerHosting } from "../src/daemon/boot";
import { resolveBrokerHosting } from "../src/daemon/boot";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Temp agent dir; every boot resolution is scoped to one. */
async function tempAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-boot-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A real upstream broker the daemon can discover. */
async function upstreamBroker(token: string): Promise<AuthBrokerServerHandle> {
	const dir = await tempAgentDir();
	const store = await SqliteAuthCredentialStore.open(join(dir, "auth.db"));
	const storage = new AuthStorage(store);
	await storage.reload();
	const handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [token],
		version: "boot-test",
		disableRefresher: true,
	});
	cleanups.push(async () => {
		await handle.close();
		storage.close();
	});
	return handle;
}

async function stopHosting(hosting: BrokerHosting): Promise<void> {
	await hosting.close();
}

// ── Discovery: external broker ───────────────────────────────────────────────

describe("resolveBrokerHosting — external broker discovered", () => {
	test("reuses a broker discovered from env", async () => {
		const upstream = await upstreamBroker("upstream-token");
		const agentDir = await tempAgentDir();

		const hosting = await resolveBrokerHosting({
			agentDir,
			env: {
				OMP_AUTH_BROKER_URL: upstream.url,
				OMP_AUTH_BROKER_TOKEN: "upstream-token",
			},
		});
		cleanups.push(() => stopHosting(hosting));

		expect(hosting.mode).toBe("external");
		expect(hosting.url).toBe(upstream.url);
		expect(hosting.adminToken).toBe("upstream-token");
	});

	test("reuses a broker discovered from config.yml", async () => {
		const upstream = await upstreamBroker("config-token");
		const agentDir = await tempAgentDir();
		await writeFile(
			join(agentDir, "config.yml"),
			`auth:\n  broker:\n    url: ${upstream.url}\n    token: config-token\n`,
			"utf8",
		);

		const hosting = await resolveBrokerHosting({ agentDir, env: {} });
		cleanups.push(() => stopHosting(hosting));

		expect(hosting.mode).toBe("external");
		expect(hosting.url).toBe(upstream.url);
		expect(hosting.adminToken).toBe("config-token");
	});

	test("env wins over config.yml", async () => {
		const fromEnv = await upstreamBroker("env-token");
		const fromConfig = await upstreamBroker("config-token");
		const agentDir = await tempAgentDir();
		await writeFile(
			join(agentDir, "config.yml"),
			`auth:\n  broker:\n    url: ${fromConfig.url}\n    token: config-token\n`,
			"utf8",
		);

		const hosting = await resolveBrokerHosting({
			agentDir,
			env: {
				OMP_AUTH_BROKER_URL: fromEnv.url,
				OMP_AUTH_BROKER_TOKEN: "env-token",
			},
		});
		cleanups.push(() => stopHosting(hosting));

		expect(hosting.url).toBe(fromEnv.url);
	});

	test("treats the discovered token as read-only: never persists it", async () => {
		const upstream = await upstreamBroker("upstream-token");
		const agentDir = await tempAgentDir();

		const hosting = await resolveBrokerHosting({
			agentDir,
			env: {
				OMP_AUTH_BROKER_URL: upstream.url,
				OMP_AUTH_BROKER_TOKEN: "upstream-token",
			},
		});
		cleanups.push(() => stopHosting(hosting));

		expect(await readdir(agentDir)).toEqual([]);
	});

	test("closing external hosting does not stop the upstream broker", async () => {
		const upstream = await upstreamBroker("upstream-token");
		const agentDir = await tempAgentDir();

		const hosting = await resolveBrokerHosting({
			agentDir,
			env: {
				OMP_AUTH_BROKER_URL: upstream.url,
				OMP_AUTH_BROKER_TOKEN: "upstream-token",
			},
		});
		await hosting.close();

		const res = await fetch(`${upstream.url}/v1/healthz`);
		expect(res.status).toBe(200);
	});

	test("rejects when a discovered broker is unreachable", async () => {
		const agentDir = await tempAgentDir();
		await expect(
			resolveBrokerHosting({
				agentDir,
				env: {
					OMP_AUTH_BROKER_URL: "http://127.0.0.1:1",
					OMP_AUTH_BROKER_TOKEN: "t",
				},
			}),
		).rejects.toThrow();
	});

	test("rejects when the discovered token is not accepted", async () => {
		const upstream = await upstreamBroker("real-token");
		const agentDir = await tempAgentDir();

		await expect(
			resolveBrokerHosting({
				agentDir,
				env: {
					OMP_AUTH_BROKER_URL: upstream.url,
					OMP_AUTH_BROKER_TOKEN: "wrong-token",
				},
			}),
		).rejects.toThrow();
	});
});

// ── Embedding: no broker discovered ──────────────────────────────────────────

describe("resolveBrokerHosting — embedded fallback", () => {
	test("embeds a broker when discovery finds nothing", async () => {
		const agentDir = await tempAgentDir();

		const hosting = await resolveBrokerHosting({ agentDir, env: {} });
		cleanups.push(() => stopHosting(hosting));

		expect(hosting.mode).toBe("embedded");
		expect(hosting.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

		const res = await fetch(`${hosting.url}/v1/healthz`);
		expect(res.status).toBe(200);
	});

	test("embedded broker authenticates with the generated admin token", async () => {
		const agentDir = await tempAgentDir();
		const hosting = await resolveBrokerHosting({ agentDir, env: {} });
		cleanups.push(() => stopHosting(hosting));

		const authorized = await fetch(`${hosting.url}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${hosting.adminToken}` },
		});
		expect(authorized.status).toBe(200);

		const rejected = await fetch(`${hosting.url}/v1/snapshot`);
		expect(rejected.status).toBe(401);
	});

	test("admin token is freshly generated per boot and unguessable", async () => {
		const first = await resolveBrokerHosting({
			agentDir: await tempAgentDir(),
			env: {},
		});
		cleanups.push(() => stopHosting(first));
		const second = await resolveBrokerHosting({
			agentDir: await tempAgentDir(),
			env: {},
		});
		cleanups.push(() => stopHosting(second));

		expect(first.adminToken).not.toBe(second.adminToken);
		expect(first.adminToken.length).toBeGreaterThanOrEqual(32);
	});

	test("admin token stays in memory: never written to the agent dir", async () => {
		const agentDir = await tempAgentDir();
		const hosting = await resolveBrokerHosting({ agentDir, env: {} });
		cleanups.push(() => stopHosting(hosting));

		for (const entry of await readdir(agentDir)) {
			expect(entry).not.toContain("token");
		}
	});

	test("binds loopback only", async () => {
		const agentDir = await tempAgentDir();
		const hosting = await resolveBrokerHosting({ agentDir, env: {} });
		cleanups.push(() => stopHosting(hosting));

		expect(new URL(hosting.url).hostname).toBe("127.0.0.1");
	});

	test("closing embedded hosting stops the broker", async () => {
		const agentDir = await tempAgentDir();
		const hosting = await resolveBrokerHosting({ agentDir, env: {} });
		const { url } = hosting;

		await hosting.close();

		await expect(fetch(`${url}/v1/healthz`)).rejects.toThrow();
	});

	test("close is idempotent", async () => {
		const hosting = await resolveBrokerHosting({
			agentDir: await tempAgentDir(),
			env: {},
		});
		await hosting.close();
		await hosting.close();
	});
});
