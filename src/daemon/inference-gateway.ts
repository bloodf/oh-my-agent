import { timingSafeEqual } from "node:crypto";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	RemoteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-broker";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	type PiNativeParsedRequest,
	parseRequest,
} from "@oh-my-pi/pi-ai/providers/pi-native-server";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

export interface ScopedInferenceGatewayOptions {
	brokerUrl: string;
	brokerToken: string;
	modelsPath: string;
	provider: string;
	modelId: string;
	workerToken: string;
	/** Override discovery fetch for isolated local-provider verification. */
	fetch?: typeof fetch;
}

export interface ScopedInferenceGateway {
	url: string;
	token: string;
	maxTokens?: number;
	close(): Promise<void>;
}

const SAFE_OPTION_KEYS: ReadonlySet<string> = new Set([
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"frequencyPenalty",
	"repetitionPenalty",
	"stopSequences",
	"maxTokens",
	"cacheRetention",
	"cachedContent",
	"maxRetryDelayMs",
	"sessionId",
	"promptCacheKey",
	"promptCache",
	"statefulResponses",
	"streamFirstEventTimeoutMs",
	"streamIdleTimeoutMs",
	"reasoning",
	"disableReasoning",
	"hideThinkingSummary",
	"thinkingBudgets",
	"toolChoice",
	"serviceTier",
	"loopGuard",
	"acceptEmptyResponse",
]);

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function bearerEquals(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function scopedRequest(body: unknown, modelId: string): string | Response {
	let parsed: PiNativeParsedRequest;
	try {
		parsed = parseRequest(body);
	} catch {
		return jsonError(400, "Invalid pi-native request");
	}
	if (parsed.modelId !== modelId) {
		return jsonError(400, "Model is not bound to this worker");
	}
	const safeOptions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed.options)) {
		if (key === "headers")
			return jsonError(400, "Worker headers are not allowed");
		// Client-only metadata and provider overrides never reach the provider.
		if (SAFE_OPTION_KEYS.has(key)) safeOptions[key] = value;
	}
	return JSON.stringify({ ...parsed, options: safeOptions });
}

interface ResolvedModel {
	api: string;
	name: string;
	input: readonly string[];
	contextWindow: number | null | undefined;
	maxTokens: number | null | undefined;
}

/**
 * Every model the given credential scope can route to, as the peer-facing
 * `provider/id` pairs, sorted. Built exactly the way the scoped gateway
 * builds its own view — a broker-backed store and OMP's model registry — so
 * what the picker offers is what a worker could actually be pointed at.
 */
export async function listRoutableModels(options: {
	brokerUrl: string;
	brokerToken: string;
	modelsPath: string;
	fetch?: typeof fetch;
}): Promise<{ provider: string; id: string; name: string }[]> {
	const client = new AuthBrokerClient({
		url: options.brokerUrl,
		token: options.brokerToken,
	});
	const snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) {
		throw new Error("credential gateway returned no snapshot");
	}
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot: snapshot.snapshot,
	});
	const storage = new AuthStorage(store);
	try {
		await storage.reload();
		const registry = new ModelRegistry(storage, options.modelsPath, {
			fetch: options.fetch,
		});
		await registry.refresh("online-if-uncached");
		return registry
			.getAvailable()
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
			}))
			.sort((a, b) =>
				`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
			);
	} finally {
		await store.close?.();
	}
}

export async function startScopedInferenceGateway(
	options: ScopedInferenceGatewayOptions,
): Promise<ScopedInferenceGateway> {
	const client = new AuthBrokerClient({
		url: options.brokerUrl,
		token: options.brokerToken,
	});
	const snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) {
		throw new Error("credential gateway returned no snapshot");
	}
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot: snapshot.snapshot,
	});
	const storage = new AuthStorage(store);
	let upstream: { url: string; close(): Promise<void> } | undefined;
	let server: Bun.Server<undefined> | undefined;
	let model: ResolvedModel | undefined;
	try {
		await storage.reload();
		const registry = new ModelRegistry(storage, options.modelsPath, {
			fetch: options.fetch,
		});
		await registry.refreshDiscoverableProviders([options.provider]);
		const found = registry.find(options.provider, options.modelId);
		if (!found) {
			throw new Error(
				`Unknown configured model: ${options.provider}/${options.modelId}`,
			);
		}
		model = {
			api: found.api,
			name: found.name,
			input: found.input,
			contextWindow: found.contextWindow,
			maxTokens: found.maxTokens,
		};
		const upstreamToken = crypto.randomUUID();
		upstream = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [upstreamToken],
			resolveModel: (requested) =>
				requested === `${options.provider}/${options.modelId}`
					? found
					: undefined,
			listModels: () => [found],
		});
		const upstreamUrl = upstream.url;
		const currentModel = model;
		const handle: ScopedInferenceGateway = {
			url: "",
			token: options.workerToken,
			...(found.maxTokens == null ? {} : { maxTokens: found.maxTokens }),
			close: () => closeAll(),
		};
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 255,
			fetch: async (request) => {
				const header = request.headers.get("Authorization");
				const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
				if (!bearerEquals(token, options.workerToken)) {
					return jsonError(401, "unauthorized");
				}
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/v1/models") {
					return new Response(
						JSON.stringify({
							object: "list",
							data: [
								{
									id: options.modelId,
									object: "model",
									owned_by: options.provider,
									api: currentModel.api,
									display_name: currentModel.name,
									input_modalities: currentModel.input,
									...(currentModel.contextWindow != null
										? { context_length: currentModel.contextWindow }
										: {}),
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (request.method !== "POST" || url.pathname !== "/v1/pi/stream") {
					return jsonError(404, "not found");
				}
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return jsonError(400, "Invalid JSON body");
				}
				const sanitized = scopedRequest(
					body,
					`${options.provider}/${options.modelId}`,
				);
				if (sanitized instanceof Response) return sanitized;
				return await fetch(`${upstreamUrl}/v1/pi/stream`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${upstreamToken}`,
						"Content-Type": "application/json",
					},
					body: sanitized,
					signal: request.signal,
				});
			},
		});
		handle.url = `http://${server.hostname}:${server.port}`;
		return handle;
	} catch (error) {
		if (server) {
			try {
				await server.stop(true);
			} catch {
				// Listener may already be torn down on rollback.
			}
		}
		if (upstream) {
			try {
				await upstream.close();
			} catch {
				// Upstream may not be open yet.
			}
		}
		storage.close();
		throw error;
	}

	async function closeAll(): Promise<void> {
		if (server) {
			const local = server;
			server = undefined;
			try {
				await local.stop(true);
			} catch {
				// Stop may race with a request; treat as closed.
			}
		}
		if (upstream) {
			const local = upstream;
			upstream = undefined;
			try {
				await local.close();
			} catch {
				// Upstream close may race with init; ignore.
			}
		}
		storage.close();
	}
}
