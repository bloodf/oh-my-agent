import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type {
	AuthBrokerClient,
	CredentialBlockSnapshot,
	HealthzResponse,
	SnapshotResponse,
	SnapshotStreamSnapshotEvent,
} from "@oh-my-pi/pi-ai/auth-broker";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient as ABClient, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";

async function withBroker(
	fn: (client: AuthBrokerClient, baseUrl: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "broker-contract-"));
	const dbPath = join(dir, "auth.db");
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const storage = new AuthStorage(store);
	await storage.reload();

	const broker = startAuthBroker({
		storage,
		bearerTokens: ["test-token"],
		version: "test-contract",
		disableRefresher: true,
	});
	const baseUrl = broker.url;
	const client = new ABClient({ url: baseUrl, token: "test-token" });

	try {
		await fn(client, baseUrl);
	} finally {
		await broker.close();
		storage.close();
		await rm(dir, { recursive: true, force: true });
	}
}

describe("auth-broker contract", () => {
	test("health requires no auth", async () => {
		await withBroker(async (_client, baseUrl) => {
			const res = await fetch(`${baseUrl}/v1/healthz`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as HealthzResponse;
			expect(body.ok).toBe(true);
		});
	});

	test("snapshot returns 401 without bearer", async () => {
		await withBroker(async (_client, baseUrl) => {
			const res = await fetch(`${baseUrl}/v1/snapshot`);
			expect(res.status).toBe(401);
		});
	});

	test("snapshot returns 200 + ETag with valid bearer", async () => {
		await withBroker(async (_client, baseUrl) => {
			const res = await fetch(`${baseUrl}/v1/snapshot`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(res.status).toBe(200);
			const etag = res.headers.get("etag");
			expect(etag).toMatch(/^"\d+"$/);
		});
	});

	test("snapshot with matching If-None-Match + wait returns 304", async () => {
		await withBroker(async (_client, baseUrl) => {
			const first = await fetch(`${baseUrl}/v1/snapshot`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(first.status).toBe(200);
			const etag = first.headers.get("etag")!;
			const second = await fetch(`${baseUrl}/v1/snapshot?wait=1`, {
				headers: { Authorization: "Bearer test-token", "If-None-Match": etag },
			});
			expect(second.status).toBe(304);
		});
	});

	test("upload API-key credential appears in snapshot", async () => {
		await withBroker(async (client, baseUrl) => {
			await client.uploadCredential("openai", { type: "api_key", key: "sk-contract-test" });
			const res = await fetch(`${baseUrl}/v1/snapshot`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as SnapshotResponse;
			const entry = body.credentials.find(e => e.provider === "openai");
			expect(entry).toBeDefined();
			expect(entry!.credential.type).toBe("api_key");
		});
	});

	test("block route updates credential snapshot with blockedUntilMs", async () => {
		await withBroker(async (client, baseUrl) => {
			await client.uploadCredential("openai", { type: "api_key", key: "sk-block-test" });
			const snap = await client.fetchSnapshot();
			if (snap.status !== 200) throw new Error(`expected 200, got ${snap.status}`);
			const entry = snap.snapshot.credentials.find(e => e.provider === "openai");
			const credId = entry!.id;

			const block: CredentialBlockSnapshot = {
				providerKey: "openai:global",
				blockScope: "",
				blockedUntilMs: Date.now() + 600_000,
			};
			const blockRes = await client.upsertCredentialBlock(credId, block);
			expect(blockRes.ok).toBe(true);

			const snapAfter = await client.fetchSnapshot();
			if (snapAfter.status !== 200) throw new Error(`expected 200, got ${snapAfter.status}`);
			const updated = snapAfter.snapshot.credentials.find(e => e.id === credId);
			const blocks = updated!.blocks ?? [];
			expect(blocks.some(b => b.blockedUntilMs === block.blockedUntilMs)).toBe(true);
		});
	});

	test("refresh nonexistent id throws", async () => {
		await withBroker(async (client) => {
			await expect(client.refreshCredential(Number.MAX_SAFE_INTEGER)).rejects.toThrow();
		});
	});

	test("SSE first event is full snapshot with kind=snapshot", async () => {
		await withBroker(async (client) => {
			await client.uploadCredential("anthropic", {
				type: "oauth",
				access: "sk-ant-sse",
				refresh: "refresh-sse",
				expires: Date.now() + 3_600_000,
				email: "sse@test.com",
				accountId: "acc_sse",
			});

			const events: SnapshotStreamSnapshotEvent[] = [];
			for await (const event of client.openSnapshotStream()) {
				events.push(event as SnapshotStreamSnapshotEvent);
				break;
			}

			expect(events.length).toBe(1);
			expect(events[0].kind).toBe("snapshot");
			expect(events[0].credentials.length).toBeGreaterThan(0);
		});
	});
});
