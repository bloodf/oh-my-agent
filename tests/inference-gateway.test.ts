/**
 * Focused regression for src/daemon/inference-gateway.ts.
 *
 * Boots a deterministic fake broker (snapshot only) and a fake provider
 * (OpenAI-compatible chat-completions) on two loopback ports, then
 * exercises the worker-facing wrapper:
 *  - live handoff: a worker bearer streams a turn end-to-end and the
 *    real configured provider receives it;
 *  - scope: unrelated model ids, injected headers, and foreign bearers
 *    are rejected before the provider is reached; client-only metadata
 *    is discarded by the wire boundary.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker";
import { startScopedInferenceGateway } from "../src/daemon/inference-gateway";

interface ProviderHit {
	method: string;
	path: string;
	authHeader: string;
}

const SNAPSHOT: SnapshotResponse = {
	generation: 1,
	generatedAt: 0,
	serverNowMs: 0,
	credentials: [],
	refresher: {
		enabled: false,
		intervalMs: 0,
		skewMs: 0,
		nextSweepInMs: Number.MAX_SAFE_INTEGER,
	},
};

const STORAGE_TOKEN = "storage-token";
const WORKER_TOKEN = "worker-token";
const PROVIDER_TOKEN = "sk-provider-secret";
const PROVIDER = "durindoor";
const MODEL_ID = "cx/gpt-5.6-sol";

const providerHits: ProviderHit[] = [];
let provider: ReturnType<typeof Bun.serve> | undefined;
let providerUrl = "";
let fakeBroker: ReturnType<typeof Bun.serve> | undefined;
let brokerUrl = "";

function providerSse(content: string): Response {
	return new Response(
		`data: ${JSON.stringify({
			choices: [{ delta: { content }, index: 0, finish_reason: null }],
		})}\n\ndata: [DONE]\n\n`,
		{
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
		},
	);
}

beforeAll(() => {
	provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			const url = new URL(request.url);
			providerHits.push({
				method: request.method,
				path: url.pathname,
				authHeader: request.headers.get("Authorization") ?? "",
			});
			if (request.method === "GET" && url.pathname === "/v1/models") {
				return Response.json({
					data: [
						{ id: MODEL_ID, context_length: 32768, max_output_tokens: 1024 },
					],
				});
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/chat/completions"
			) {
				if (
					request.headers.get("Authorization") !== `Bearer ${PROVIDER_TOKEN}`
				) {
					return new Response("unauthorized", { status: 401 });
				}
				return providerSse("ok");
			}
			return new Response("not found", { status: 404 });
		},
	});
	providerUrl = `http://${provider.hostname}:${provider.port}`;

	fakeBroker = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/v1/snapshot") {
				if (
					request.headers.get("Authorization") !== `Bearer ${STORAGE_TOKEN}`
				) {
					return new Response("unauthorized", { status: 401 });
				}
				return new Response(JSON.stringify(SNAPSHOT), {
					headers: {
						"Content-Type": "application/json",
						ETag: `"${SNAPSHOT.generation}"`,
						"Cache-Control": "no-store",
					},
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	brokerUrl = `http://${fakeBroker.hostname}:${fakeBroker.port}`;
});

afterEach(() => {
	providerHits.length = 0;
});

afterAll(async () => {
	if (provider) {
		await provider.stop(true);
		provider = undefined;
	}
	if (fakeBroker) {
		await fakeBroker.stop(true);
		fakeBroker = undefined;
	}
});

describe("scoped inference gateway", () => {
	test("routes a live turn and rejects out-of-scope model/options/auth", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "oma-inference-"));
		try {
			const modelsPath = join(agentDir, "models.yml");
			await writeFile(
				modelsPath,
				`providers:\n  ${PROVIDER}:\n    baseUrl: ${providerUrl}/v1\n    apiKey: ${PROVIDER_TOKEN}\n    api: openai-completions\n    discovery:\n      type: openai-models-list\n`,
			);
			const scoped = await startScopedInferenceGateway({
				brokerUrl,
				brokerToken: STORAGE_TOKEN,
				modelsPath,
				provider: PROVIDER,
				modelId: MODEL_ID,
				workerToken: WORKER_TOKEN,
				fetch,
			});
			try {
				const ok = await fetch(`${scoped.url}/v1/pi/stream`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${WORKER_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						modelId: `${PROVIDER}/${MODEL_ID}`,
						context: { messages: [{ role: "user", content: "hi" }] },
						options: {
							model: {
								provider: "other",
								id: "ignored",
								baseUrl: "http://invalid",
							},
							interruptMode: "immediate",
							metadata: { route: "ignored-client-metadata" },
						},
					}),
				});
				expect(ok.status).toBe(200);
				const events = await ok.text();
				expect(events).toContain('"text":"ok"');
				const providerCall = providerHits.find(
					(h) => h.path === "/v1/chat/completions",
				);
				expect(providerCall).toBeDefined();
				expect(providerCall?.authHeader).toBe(`Bearer ${PROVIDER_TOKEN}`);

				const beforeRejects = providerHits.length;

				const wrongModel = await fetch(`${scoped.url}/v1/pi/stream`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${WORKER_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						modelId: "openai/gpt-4",
						context: { messages: [{ role: "user", content: "hi" }] },
					}),
				});
				expect(wrongModel.status).toBe(400);

				const leakedHeaders = await fetch(`${scoped.url}/v1/pi/stream`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${WORKER_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						modelId: `${PROVIDER}/${MODEL_ID}`,
						context: { messages: [{ role: "user", content: "hi" }] },
						options: { headers: { Authorization: "Bearer attacker" } },
					}),
				});
				expect(leakedHeaders.status).toBe(400);

				const badAuth = await fetch(`${scoped.url}/v1/pi/stream`, {
					method: "POST",
					headers: {
						Authorization: "Bearer other",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						modelId: `${PROVIDER}/${MODEL_ID}`,
						context: { messages: [{ role: "user", content: "hi" }] },
					}),
				});
				expect(badAuth.status).toBe(401);

				expect(providerHits.length).toBe(beforeRejects);

				const models = await fetch(`${scoped.url}/v1/models`, {
					headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
				});
				expect(models.status).toBe(200);
				const body = (await models.json()) as {
					data: Array<{ id: string; owned_by: string }>;
				};
				expect(body.data[0]?.id).toBe(MODEL_ID);
				expect(body.data[0]?.owned_by).toBe(PROVIDER);
			} finally {
				await scoped.close();
			}
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
