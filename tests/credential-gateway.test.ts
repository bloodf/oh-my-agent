/**
 * RED tests for src/daemon/credential-gateway.ts
 *
 * Public API under test: startCredentialGateway(options) -> CredentialGateway
 *
 * Architecture contract (§9.6). The gateway sits between a worker's
 * `RemoteAuthCredentialStore` and the upstream broker. Per-worker tokens are
 * bound to one account, and the gateway:
 *
 *  - filters `/v1/snapshot`, `/v1/snapshot/stream`, refresh, block, and usage
 *    to that worker's bound credentials;
 *  - rewrites upstream generations into a monotonically increasing
 *    per-worker "worker-view" generation;
 *  - answers foreign-id access, credential upload, and `/v1/usage/clients`
 *    admin-only;
 *  - proxies disable for a dedicated account, but for a *shared* account
 *    queues a policy request, returns retryable
 *    `409 {status:"pending_policy", requestId}`, leaves upstream untouched,
 *    bumps only the requester's worker-view generation, and immediately emits
 *    a full filtered snapshot so the requester's store — which already removed
 *    the credential locally (remote-store.ts:710-717) — restores it via the
 *    generation-not-older path (remote-store.ts:504-511).
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker";
import {
	historyMatchesIdentity,
	reportMatchesIdentity,
	startCredentialGateway,
} from "../src/daemon/credential-gateway";
import type { BoundIdentity, CredentialGateway } from "../src/daemon/credential-gateway";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const ADMIN_TOKEN = "admin-token";

interface Upstream {
	url: string;
	store: SqliteAuthCredentialStore;
	/** Credential ids by provider, in insertion order. */
	ids: Record<string, number>;
}

/**
 * A real broker holding one credential per provider. `openai` and `anthropic`
 * stand in for two separate accounts.
 */
async function upstream(): Promise<Upstream> {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-gw-"));
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
	// Reload after seeding: the broker answers from the storage snapshot, so
	// rows written straight to the store must be pulled in before it starts.
	await storage.reload();


	const handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [ADMIN_TOKEN],
		version: "gateway-test",
		disableRefresher: true,
	});
	cleanups.push(async () => {
		await handle.close();
		storage.close();
		await rm(dir, { recursive: true, force: true });
	});

	return { url: handle.url, store, ids };
}

async function gatewayFor(up: Upstream): Promise<CredentialGateway> {
	const gateway = await startCredentialGateway({
		upstreamUrl: up.url,
		adminToken: ADMIN_TOKEN,
	});
	cleanups.push(() => gateway.close());
	return gateway;
}

async function snapshotVia(gateway: CredentialGateway, token: string): Promise<Response> {
	return await fetch(`${gateway.url}/v1/snapshot`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

/** Read SSE events until `count` are collected or the deadline elapses. */
async function readEvents(
	url: string,
	token: string,
	count: number,
	trigger?: () => Promise<void>,
): Promise<Record<string, unknown>[]> {
	const controller = new AbortController();
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
		signal: controller.signal,
	});
	const reader = res.body?.getReader();
	if (!reader) throw new Error("stream had no body");

	const events: Record<string, unknown>[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	let triggered = false;

	// Real deadline, not a sleep: this reads a live HTTP SSE stream, so there is
	// no fake clock to advance — it only bounds a hang, never paces assertions.
	const deadline = setTimeout(() => controller.abort(), 5_000);
	try {
		while (events.length < count) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let index: number;
			while ((index = buffer.indexOf("\n\n")) !== -1) {
				const frame = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (payload.length === 0) continue;
					events.push(JSON.parse(payload) as Record<string, unknown>);
				}
			}

			if (!triggered && trigger && events.length >= 1) {
				triggered = true;
				await trigger();
			}
		}
	} finally {
		clearTimeout(deadline);
		controller.abort();
	}
	return events;
}

// ── Token issuance + binding ─────────────────────────────────────────────────

describe("worker token issuance", () => {
	test("issues a distinct token per worker", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);

		const a = gateway.issueWorkerToken({ workerId: "reviewer", credentialIds: [up.ids.openai] });
		const b = gateway.issueWorkerToken({ workerId: "scout", credentialIds: [up.ids.openai] });

		expect(a.token).not.toBe(b.token);
		expect(a.token.length).toBeGreaterThanOrEqual(32);
	});

	test("revoking a worker token stops its access", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		expect((await snapshotVia(gateway, worker.token)).status).toBe(200);
		gateway.revokeWorkerToken(worker.token);
		expect((await snapshotVia(gateway, worker.token)).status).toBe(401);
	});

	test("unknown bearer is rejected", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		expect((await snapshotVia(gateway, "not-a-token")).status).toBe(401);
	});

	test("the upstream admin token is not accepted as a worker token", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const res = await fetch(`${gateway.url}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
		});
		expect(res.status).toBe(401);
	});

	test("binds loopback only", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		expect(new URL(gateway.url).hostname).toBe("127.0.0.1");
	});
});

// ── Snapshot filtering ───────────────────────────────────────────────────────

describe("snapshot filtering", () => {
	test("returns only bound credentials", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const body = (await (await snapshotVia(gateway, worker.token)).json()) as SnapshotResponse;
		expect(body.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});

	test("two workers see disjoint credential sets", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const a = gateway.issueWorkerToken({ workerId: "a", credentialIds: [up.ids.openai] });
		const b = gateway.issueWorkerToken({ workerId: "b", credentialIds: [up.ids.anthropic] });

		const aBody = (await (await snapshotVia(gateway, a.token)).json()) as SnapshotResponse;
		const bBody = (await (await snapshotVia(gateway, b.token)).json()) as SnapshotResponse;

		expect(aBody.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
		expect(bBody.credentials.map((c) => c.id)).toEqual([up.ids.anthropic]);
	});

	test("snapshot carries an ETag matching the worker-view generation", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await snapshotVia(gateway, worker.token);
		const body = (await res.json()) as SnapshotResponse;
		expect(res.headers.get("etag")).toBe(`"${body.generation}"`);
	});

	test("worker-view generation is independent of upstream numbering", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const upstreamBody = (await (
			await fetch(`${up.url}/v1/snapshot`, {
				headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
			})
		).json()) as SnapshotResponse;
		const workerBody = (await (await snapshotVia(gateway, worker.token)).json()) as SnapshotResponse;

		expect(workerBody.generation).toBeGreaterThan(0);
		expect(workerBody.generation).not.toBe(upstreamBody.generation);
	});

	test("worker-view generation never decreases across reads", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const first = (await (await snapshotVia(gateway, worker.token)).json()) as SnapshotResponse;
		const second = (await (await snapshotVia(gateway, worker.token)).json()) as SnapshotResponse;
		expect(second.generation).toBeGreaterThanOrEqual(first.generation);
	});
});

// ── Foreign ids and admin-only routes ────────────────────────────────────────

describe("route scoping", () => {
	test("refresh of a bound credential is proxied", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/refresh`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}` },
		});
		expect(res.status).not.toBe(403);
	});

	test("refresh of a foreign credential returns 403", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/credential/${up.ids.anthropic}/refresh`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}` },
		});
		expect(res.status).toBe(403);
	});

	test("block of a foreign credential returns 403", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/credential/${up.ids.google}/block`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ providerKey: "google", blockScope: "account", blockedUntilMs: Date.now() + 1000 }),
		});
		expect(res.status).toBe(403);
	});

	test("block of a bound credential reaches upstream", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/block`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ providerKey: "openai", blockScope: "account", blockedUntilMs: Date.now() + 60_000 }),
		});
		expect(res.ok).toBe(true);
	});

	test("credential upload is admin-only", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/credential`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "openai", credential: { type: "api_key", key: "smuggled" } }),
		});
		expect(res.status).toBe(403);
	});

	test("/v1/usage/clients is admin-only", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/usage/clients`, {
			headers: { Authorization: `Bearer ${worker.token}` },
		});
		expect(res.status).toBe(403);
	});

	test("aggregate usage stays reachable but carries no co-tenant reports", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		// Stock RemoteAuthCredentialStore polls this for ranking and quota, so it
		// must answer 200. API-key credentials assert no account identity, so no
		// report is affirmatively attributable and none may leak through.
		const res = await fetch(`${gateway.url}/v1/usage?provider=openai`, {
			headers: { Authorization: `Bearer ${worker.token}` },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { reports: unknown[] }).reports).toEqual([]);
	});

	test("usage history is empty without an affirmative identity match", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/usage/history`, {
			headers: { Authorization: `Bearer ${worker.token}` },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
	});

	test("observed usage reporting is accepted", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installId: "worker", hostname: "worker", entries: [] }),
		});
		expect(res.status).toBeLessThan(500);
		expect(res.status).not.toBe(403);
	});

	test("healthz needs no auth", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		expect((await fetch(`${gateway.url}/v1/healthz`)).status).toBe(200);
	});
});

// ── Disable: dedicated vs shared ─────────────────────────────────────────────

describe("disable — dedicated account", () => {
	test("proxies upstream and returns its result", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const res = await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "rotated" }),
		});

		expect(res.ok).toBe(true);
		expect(up.store.listAuthCredentials("openai")).toHaveLength(0);
	});
});

describe("disable — shared account", () => {
	test("returns retryable 409 pending_policy with a requestId", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		const res = await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "quota" }),
		});

		expect(res.status).toBe(409);
		const body = (await res.json()) as { status: string; requestId: string };
		expect(body.status).toBe("pending_policy");
		expect(body.requestId.length).toBeGreaterThan(0);
	});

	test("leaves upstream state unchanged", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "quota" }),
		});

		expect(up.store.listAuthCredentials("openai")).toHaveLength(1);
	});

	test("queues an idempotent policy request carrying credential id and worker id", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		const send = async () =>
			(await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
				method: "POST",
				headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ cause: "quota" }),
			}).then((r) => r.json())) as { requestId: string };

		const first = await send();
		const second = await send();

		expect(second.requestId).toBe(first.requestId);
		expect(gateway.pendingPolicyRequests()).toEqual([
			{ requestId: first.requestId, credentialId: up.ids.openai, workerId: "reviewer" },
		]);
	});

	test("bumps only the requester's worker-view generation", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		const peer = gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		const peerBefore = (await (await snapshotVia(gateway, peer.token)).json()) as SnapshotResponse;
		const requesterBefore = (await (
			await snapshotVia(gateway, requester.token)
		).json()) as SnapshotResponse;

		await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "quota" }),
		});

		const peerAfter = (await (await snapshotVia(gateway, peer.token)).json()) as SnapshotResponse;
		const requesterAfter = (await (
			await snapshotVia(gateway, requester.token)
		).json()) as SnapshotResponse;

		expect(requesterAfter.generation).toBeGreaterThan(requesterBefore.generation);
		expect(peerAfter.generation).toBe(peerBefore.generation);
	});

	test("peers keep seeing the credential", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		const peer = gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "quota" }),
		});

		const body = (await (await snapshotVia(gateway, peer.token)).json()) as SnapshotResponse;
		expect(body.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});
});

// ── Requester recovery over SSE ──────────────────────────────────────────────

describe("requester recovery", () => {
	test("pending disable emits a full snapshot with a newer generation", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		const events = await readEvents(
			`${gateway.url}/v1/snapshot/stream`,
			requester.token,
			2,
			async () => {
				await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${requester.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ cause: "quota" }),
				});
			},
		);

		const initial = events[0] as unknown as SnapshotResponse & { kind: string };
		const recovery = events[1] as unknown as SnapshotResponse & { kind: string };

		expect(recovery.kind).toBe("snapshot");
		expect(recovery.generation).toBeGreaterThan(initial.generation);
		// A full snapshot, not a delta: this is what restores the credential the
		// requester's store already dropped locally.
		expect(recovery.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});

	test("stream only carries bound credentials", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const events = await readEvents(`${gateway.url}/v1/snapshot/stream`, worker.token, 1);
		const initial = events[0] as unknown as SnapshotResponse;
		expect(initial.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});
});


// ── Conditional long-poll ────────────────────────────────────────────────────

describe("conditional long-poll", () => {
	test("matching ETag with wait returns 304 when nothing changes", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});

		const first = await snapshotVia(gateway, worker.token);
		const etag = first.headers.get("etag");
		if (!etag) throw new Error("snapshot did not carry an ETag");

		const res = await fetch(`${gateway.url}/v1/snapshot?wait=1`, {
			headers: { Authorization: `Bearer ${worker.token}`, "If-None-Match": etag },
		});
		expect(res.status).toBe(304);
	});

	test("pending shared disable wakes the requester's long-poll with a full snapshot", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		const first = await snapshotVia(gateway, requester.token);
		const before = (await first.json()) as SnapshotResponse;
		const etag = first.headers.get("etag");
		if (!etag) throw new Error("snapshot did not carry an ETag");

		const polling = fetch(`${gateway.url}/v1/snapshot?wait=10`, {
			headers: { Authorization: `Bearer ${requester.token}`, "If-None-Match": etag },
		});

		const disable = await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "quota" }),
		});
		expect(disable.status).toBe(409);

		const res = await polling;
		expect(res.status).toBe(200);
		const body = (await res.json()) as SnapshotResponse;
		expect(body.generation).toBeGreaterThan(before.generation);
		// Full snapshot: the credential the requester dropped locally comes back.
		expect(body.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});

	test("a peer's long-poll is not woken by another worker's pending disable", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const requester = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai],
		});
		const peer = gateway.issueWorkerToken({ workerId: "peer", credentialIds: [up.ids.openai] });

		const first = await snapshotVia(gateway, peer.token);
		const etag = first.headers.get("etag");
		if (!etag) throw new Error("snapshot did not carry an ETag");

		const polling = fetch(`${gateway.url}/v1/snapshot?wait=1`, {
			headers: { Authorization: `Bearer ${peer.token}`, "If-None-Match": etag },
		});

		await fetch(`${gateway.url}/v1/credential/${up.ids.openai}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${requester.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "quota" }),
		});

		expect((await polling).status).toBe(304);
	});
});

// ── Upstream change propagation ──────────────────────────────────────────────

describe("upstream change propagation", () => {
	test("a third-party disable advances the worker view", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai, up.ids.anthropic],
		});

		const before = (await (await snapshotVia(gateway, worker.token)).json()) as SnapshotResponse;

		const res = await fetch(`${up.url}/v1/credential/${up.ids.anthropic}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "rotated" }),
		});
		expect(res.ok).toBe(true);

		const after = (await (await snapshotVia(gateway, worker.token)).json()) as SnapshotResponse;
		// The store ignores events not newer than what it holds, so the worker
		// view must advance or the worker keeps using a dead credential.
		expect(after.generation).toBeGreaterThan(before.generation);
		expect(after.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});

	test("an idle SSE stream receives a third-party change without polling", async () => {
		const up = await upstream();
		const gateway = await gatewayFor(up);
		const worker = gateway.issueWorkerToken({
			workerId: "reviewer",
			credentialIds: [up.ids.openai, up.ids.anthropic],
		});

		// The worker only opens a stream — it issues no snapshot requests, so the
		// gateway's own upstream watcher is the only path that can wake it.
		const events = await readEvents(
			`${gateway.url}/v1/snapshot/stream`,
			worker.token,
			2,
			async () => {
				await fetch(`${up.url}/v1/credential/${up.ids.anthropic}/disable`, {
					method: "POST",
					headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
					body: JSON.stringify({ cause: "rotated" }),
				});
			},
		);

		const initial = events[0] as unknown as SnapshotResponse;
		const pushed = events[1] as unknown as SnapshotResponse;
		expect(pushed.generation).toBeGreaterThan(initial.generation);
		expect(pushed.credentials.map((c) => c.id)).toEqual([up.ids.openai]);
	});
});

// ── Account filtering (pure) ─────────────────────────────────────────────────

describe("usage account filtering", () => {
	// Two OAuth accounts on the SAME provider: the case provider-level filtering
	// would leak. Identities mirror what boundIdentities() derives from a
	// snapshot entry.
	const alice: BoundIdentity = {
		provider: "anthropic",
		accountId: "acct-alice",
		email: "alice@example.com",
		identifiable: true,
	};
	const bob: BoundIdentity = {
		provider: "anthropic",
		accountId: "acct-bob",
		email: "bob@example.com",
		identifiable: true,
	};
	const apiKeyOnly: BoundIdentity = { provider: "anthropic", identifiable: false };

	const aliceReport = {
		provider: "anthropic",
		metadata: { accountId: "acct-alice", email: "alice@example.com" },
	};
	const bobReport = {
		provider: "anthropic",
		metadata: { accountId: "acct-bob", email: "bob@example.com" },
	};
	const unattributed = { provider: "anthropic" };

	test("each account matches only its own report", () => {
		expect(reportMatchesIdentity(aliceReport, alice)).toBe(true);
		expect(reportMatchesIdentity(bobReport, alice)).toBe(false);
		expect(reportMatchesIdentity(aliceReport, bob)).toBe(false);
		expect(reportMatchesIdentity(bobReport, bob)).toBe(true);
	});

	test("filtering a mixed report set yields disjoint views", () => {
		const reports = [aliceReport, bobReport, unattributed];
		const forAlice = reports.filter((r) => reportMatchesIdentity(r, alice));
		const forBob = reports.filter((r) => reportMatchesIdentity(r, bob));

		expect(forAlice).toEqual([aliceReport]);
		expect(forBob).toEqual([bobReport]);
	});

	test("an unattributed report reaches nobody", () => {
		expect(reportMatchesIdentity(unattributed, alice)).toBe(false);
		expect(reportMatchesIdentity(unattributed, bob)).toBe(false);
	});

	test("an api-key binding matches no report", () => {
		for (const report of [aliceReport, bobReport, unattributed]) {
			expect(reportMatchesIdentity(report, apiKeyOnly)).toBe(false);
		}
	});

	test("org scope must agree", () => {
		const scoped: BoundIdentity = { ...alice, orgId: "org-1" };
		const orgReport = {
			provider: "anthropic",
			metadata: { orgId: "org-1", accountId: "acct-alice" },
		};
		const otherOrg = {
			provider: "anthropic",
			metadata: { orgId: "org-2", accountId: "acct-alice" },
		};

		expect(reportMatchesIdentity(orgReport, scoped)).toBe(true);
		expect(reportMatchesIdentity(otherOrg, scoped)).toBe(false);
		// Presence mismatch is a non-match in both directions.
		expect(reportMatchesIdentity(orgReport, alice)).toBe(false);
		expect(reportMatchesIdentity(aliceReport, scoped)).toBe(false);
	});

	test("a different provider never matches", () => {
		expect(reportMatchesIdentity({ ...aliceReport, provider: "openai" }, alice)).toBe(false);
	});

	test("history rows filter to their own account", () => {
		const rows = [
			{ provider: "anthropic", accountId: "acct-alice", email: "alice@example.com" },
			{ provider: "anthropic", accountId: "acct-bob", email: "bob@example.com" },
			{ provider: "openai", accountId: "acct-alice", email: "alice@example.com" },
		];

		expect(rows.filter((r) => historyMatchesIdentity(r, alice))).toEqual([rows[0]]);
		expect(rows.filter((r) => historyMatchesIdentity(r, bob))).toEqual([rows[1]]);
		expect(rows.filter((r) => historyMatchesIdentity(r, apiKeyOnly))).toEqual([]);
	});
});

// ── Route-level account isolation ────────────────────────────────────────────

describe("usage routes isolate same-provider accounts", () => {
	const ALICE_ID = 101;
	const BOB_ID = 202;

	const aliceReport = {
		provider: "anthropic",
		fetchedAt: 1,
		limits: [],
		metadata: { accountId: "acct-alice", email: "alice@example.com" },
	};
	const bobReport = {
		provider: "anthropic",
		fetchedAt: 1,
		limits: [],
		metadata: { accountId: "acct-bob", email: "bob@example.com" },
	};

	/** Upstream stub: two OAuth accounts on one provider, plus their usage. */
	const stubUpstream = async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const path = url.pathname;
		const body = (value: unknown) =>
			new Response(JSON.stringify(value), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		if (path === "/v1/snapshot") {
			// Honor the conditional long-poll the gateway's watcher issues, so it
			// parks instead of spinning on an unchanging fixture.
			const seen = new Headers(init?.headers).get("If-None-Match");
			if (seen === '"7"') {
				// Park like a real conditional long-poll until the gateway aborts.
				if (init?.signal?.aborted) throw new Error("aborted");
				const { promise, reject } = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
				return await promise;
			}
			return body({
				generation: 7,
				credentials: [
					{
						id: ALICE_ID,
						provider: "anthropic",
						credential: { type: "oauth", accountId: "acct-alice", email: "alice@example.com" },
					},
					{
						id: BOB_ID,
						provider: "anthropic",
						credential: { type: "oauth", accountId: "acct-bob", email: "bob@example.com" },
					},
				],
			});
		}
		if (path === "/v1/usage") return body({ generatedAt: 1, reports: [aliceReport, bobReport] });
		if (path === "/v1/usage/history") {
			return body({
				generatedAt: 1,
				entries: [
					{ provider: "anthropic", accountId: "acct-alice", email: "alice@example.com", limitId: "5h" },
					{ provider: "anthropic", accountId: "acct-bob", email: "bob@example.com", limitId: "5h" },
				],
			});
		}
		return new Response("not found", { status: 404 });
	};

	async function stubbedGateway(): Promise<CredentialGateway> {
		const gateway = await startCredentialGateway({
			upstreamUrl: "http://upstream.invalid",
			adminToken: ADMIN_TOKEN,
			fetchUpstream: stubUpstream,
		});
		cleanups.push(() => gateway.close());
		return gateway;
	}

	test("each worker's /v1/usage carries only its own account", async () => {
		const gateway = await stubbedGateway();
		const alice = gateway.issueWorkerToken({ workerId: "alice", credentialIds: [ALICE_ID] });
		const bob = gateway.issueWorkerToken({ workerId: "bob", credentialIds: [BOB_ID] });

		const read = async (token: string) =>
			(await (
				await fetch(`${gateway.url}/v1/usage`, { headers: { Authorization: `Bearer ${token}` } })
			).json()) as { reports: { metadata: { accountId: string } }[] };

		expect((await read(alice.token)).reports.map((r) => r.metadata.accountId)).toEqual([
			"acct-alice",
		]);
		expect((await read(bob.token)).reports.map((r) => r.metadata.accountId)).toEqual(["acct-bob"]);
	});

	test("each worker's /v1/usage/history carries only its own account", async () => {
		const gateway = await stubbedGateway();
		const alice = gateway.issueWorkerToken({ workerId: "alice", credentialIds: [ALICE_ID] });
		const bob = gateway.issueWorkerToken({ workerId: "bob", credentialIds: [BOB_ID] });

		const read = async (token: string) =>
			(await (
				await fetch(`${gateway.url}/v1/usage/history`, {
					headers: { Authorization: `Bearer ${token}` },
				})
			).json()) as { entries: { accountId: string }[] };

		expect((await read(alice.token)).entries.map((e) => e.accountId)).toEqual(["acct-alice"]);
		expect((await read(bob.token)).entries.map((e) => e.accountId)).toEqual(["acct-bob"]);
	});

	test("a worker bound to both accounts sees both", async () => {
		const gateway = await stubbedGateway();
		const both = gateway.issueWorkerToken({
			workerId: "both",
			credentialIds: [ALICE_ID, BOB_ID],
		});

		const res = (await (
			await fetch(`${gateway.url}/v1/usage`, {
				headers: { Authorization: `Bearer ${both.token}` },
			})
		).json()) as { reports: { metadata: { accountId: string } }[] };

		expect(res.reports.map((r) => r.metadata.accountId)).toEqual(["acct-alice", "acct-bob"]);
	});

	test("close() completes while the watcher is parked on a long-poll", async () => {
		const gateway = await startCredentialGateway({
			upstreamUrl: "http://upstream.invalid",
			adminToken: ADMIN_TOKEN,
			fetchUpstream: stubUpstream,
		});
		const { url } = gateway;

		// The stub parks every conditional snapshot, so the watcher is blocked in
		// flight. close() must abort it and return rather than hang.
		await gateway.close();

		// Idempotent, and the server is really down.
		await gateway.close();
		await expect(fetch(`${url}/v1/healthz`)).rejects.toThrow();
	});
});