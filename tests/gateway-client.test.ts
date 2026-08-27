/**
 * T-303 — the gateway driven by a real `RemoteAuthCredentialStore`.
 *
 * `tests/credential-gateway.test.ts` drives the gateway with `fetch`, so it
 * proves the *wire* is right: a shared disable answers `409 pending_policy`
 * and a full snapshot follows carrying a newer worker-view generation. What it
 * cannot prove is that the stock client reacts correctly to those bytes.
 *
 * That gap matters because `deleteAuthCredential` drops the credential from
 * the client's local snapshot *before* the broker answers
 * (remote-store.ts:710-717). If the recovery snapshot were shaped even
 * slightly wrong — a stale generation, a filtered-out entry — the requester
 * would silently lose a credential it still owns, and every wire assertion
 * would still pass.
 *
 * This suite therefore asserts on client state, never on a response body.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";

import { startCredentialGateway } from "../src/daemon/credential-gateway";
import type { CredentialGateway } from "../src/daemon/credential-gateway";

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * Two teardown stages. Every `RemoteAuthCredentialStore` runs a background
 * sync loop that parks on a 30s long-poll even with `streamSnapshots: false`,
 * and `gateway.close()` calls `server.stop(true)`, which waits for in-flight
 * requests. Closing the gateway while a client still holds that poll therefore
 * hangs the hook. Stores are torn down first, unconditionally.
 */
const storeCleanups: (() => void)[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (storeCleanups.length > 0) storeCleanups.pop()?.();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const ADMIN_TOKEN = "admin-token";

interface Upstream {
	url: string;
	ids: Record<string, number>;
}

/** A real broker holding one credential per provider, each a separate account. */
async function upstream(): Promise<Upstream> {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-client-"));
	const store = await SqliteAuthCredentialStore.open(join(dir, "auth.db"));
	const storage = new AuthStorage(store);

	const ids: Record<string, number> = {};
	for (const provider of ["openai", "anthropic", "google"]) {
		const [entry] = store.upsertAuthCredentialForProvider(provider, {
			type: "api_key",
			key: `${provider}-key`,
		});
		if (!entry) throw new Error(`fixture credential missing for ${provider}`);
		ids[provider] = entry.id;
	}
	// The broker answers from the storage snapshot, so rows written straight to
	// the store must be pulled in before it starts.
	await storage.reload();

	const handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [ADMIN_TOKEN],
		version: "client-test",
		disableRefresher: true,
	});
	cleanups.push(async () => {
		await handle.close();
		storage.close();
		await rm(dir, { recursive: true, force: true });
	});

	return { url: handle.url, ids };
}

async function gatewayFor(up: Upstream): Promise<CredentialGateway> {
	const gateway = await startCredentialGateway({
		upstreamUrl: up.url,
		adminToken: ADMIN_TOKEN,
	});
	cleanups.push(() => gateway.close());
	return gateway;
}

/**
 * A stock client pointed at the gateway with a worker token. Streaming is off
 * unless a test needs it, so generations advance explicitly rather than racing
 * a background watcher.
 */
async function storeFor(
	gateway: CredentialGateway,
	token: string,
	opts: { streamSnapshots?: boolean } = {},
): Promise<RemoteAuthCredentialStore> {
	const client = new AuthBrokerClient({ url: gateway.url, token });
	const store = new RemoteAuthCredentialStore({
		client,
		streamSnapshots: opts.streamSnapshots ?? false,
	});
	storeCleanups.push(() => store.close());
	await store.refreshSnapshot();
	return store;
}

const idsOf = (store: RemoteAuthCredentialStore): number[] =>
	store.listAuthCredentials().map((c) => c.id);

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return predicate();
}

// ── Scoping, through the real client ─────────────────────────────────────────

describe("a real store reads through the gateway", () => {
	test("loads exactly its bound credentials", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const { token } = gateway.issueWorkerToken({
			workerId: "w1",
			credentialIds: [up.ids.openai, up.ids.google],
		});

		const store = await storeFor(gateway, token);

		expect(idsOf(store)).toContain(up.ids.openai);
		expect(idsOf(store)).toContain(up.ids.google);
		expect(idsOf(store)).not.toContain(up.ids.anthropic);
	});

	test("two stores on one gateway stay disjoint", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const a = gateway.issueWorkerToken({ workerId: "a", credentialIds: [up.ids.openai] });
		const b = gateway.issueWorkerToken({ workerId: "b", credentialIds: [up.ids.anthropic] });

		const storeA = await storeFor(gateway, a.token);
		const storeB = await storeFor(gateway, b.token);

		expect(idsOf(storeA)).toEqual([up.ids.openai]);
		expect(idsOf(storeB)).toEqual([up.ids.anthropic]);
	});

	test("a revoked token stops the store from refreshing", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "w1",
			credentialIds: [up.ids.openai],
		});
		const store = await storeFor(gateway, worker.token);
		expect(idsOf(store)).toEqual([up.ids.openai]);

		gateway.revokeWorkerToken(worker.token);

		// The client surfaces the rejection rather than quietly serving a stale
		// snapshot it can no longer refresh.
		await expect(store.refreshSnapshot()).rejects.toThrow();
	});
});

// ── The path only a real client can exercise ─────────────────────────────────

describe("requester recovery after a refused shared disable", () => {
	test("the requester's store ends holding the credential again", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const shared = up.ids.openai;

		// Two workers bound to the same credential make the account shared, so a
		// disable from either cannot be unilateral.
		const requester = gateway.issueWorkerToken({ workerId: "r", credentialIds: [shared] });
		const peer = gateway.issueWorkerToken({ workerId: "p", credentialIds: [shared] });

		const requesterStore = await storeFor(gateway, requester.token, { streamSnapshots: true });
		const peerStore = await storeFor(gateway, peer.token, { streamSnapshots: true });
		expect(idsOf(requesterStore)).toContain(shared);

		// `deleteAuthCredential` removes locally first, then tells the broker.
		requesterStore.deleteAuthCredential(shared, "worker asked to disable");

		// Right after the call the client has already dropped it. This local
		// removal is the state the gateway's recovery snapshot must undo.
		expect(idsOf(requesterStore)).not.toContain(shared);

		// No manual reload: the gateway must restore it on its own.
		expect(await waitFor(() => idsOf(requesterStore).includes(shared))).toBe(true);

		// The peer, which asked for nothing, was never disturbed.
		expect(idsOf(peerStore)).toContain(shared);
	});

	test("the refusal never reaches upstream", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const shared = up.ids.openai;
		const requester = gateway.issueWorkerToken({ workerId: "r", credentialIds: [shared] });
		gateway.issueWorkerToken({ workerId: "p", credentialIds: [shared] });

		const store = await storeFor(gateway, requester.token, { streamSnapshots: true });
		store.deleteAuthCredential(shared, "worker asked to disable");
		await waitFor(() => idsOf(store).includes(shared));

		const admin = new AuthBrokerClient({ url: up.url, token: ADMIN_TOKEN });
		const result = await admin.fetchSnapshot();
		if (result.status !== 200) throw new Error("upstream snapshot unavailable");
		expect(result.snapshot.credentials.map((c) => c.id)).toContain(shared);
	});

	test("the disable is queued for a human", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const shared = up.ids.openai;
		const requester = gateway.issueWorkerToken({ workerId: "r", credentialIds: [shared] });
		gateway.issueWorkerToken({ workerId: "p", credentialIds: [shared] });

		const store = await storeFor(gateway, requester.token, { streamSnapshots: true });
		store.deleteAuthCredential(shared, "worker asked to disable");
		await waitFor(() => gateway.pendingPolicyRequests().length > 0);

		const queued = gateway.pendingPolicyRequests();
		expect(queued).toHaveLength(1);
		expect(queued[0]?.credentialId).toBe(shared);
		expect(queued[0]?.workerId).toBe("r");
	});

	test("a dedicated-account disable is allowed through", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const own = up.ids.anthropic;

		// Only one worker is bound, so nothing is shared and the disable stands.
		const worker = gateway.issueWorkerToken({ workerId: "solo", credentialIds: [own] });
		const store = await storeFor(gateway, worker.token, { streamSnapshots: true });
		expect(idsOf(store)).toContain(own);

		store.deleteAuthCredential(own, "worker owns this account");

		// It must stay gone: no recovery snapshot resurrects a legitimate disable.
		await new Promise((r) => setTimeout(r, 400));
		expect(idsOf(store)).not.toContain(own);
	});
});
