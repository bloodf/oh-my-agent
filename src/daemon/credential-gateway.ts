/**
 * Purpose: Front the upstream auth broker with a per-worker scoped view (§9.6).
 * Each worker gets its own bearer bound to one account's credentials; the
 * gateway filters every broker route to those ids and renumbers generations
 * into a per-worker monotonic "worker-view" sequence.
 *
 * Public API: `startCredentialGateway(options): Promise<CredentialGateway>`.
 *
 * Upstream deps: the broker's HTTP surface (`/v1/snapshot`, `/v1/snapshot/stream`,
 * `/v1/credential/:id/{refresh,block,disable}`, `/v1/usage*`), reached with the
 * daemon's admin token.
 *
 * Downstream consumers: each worker's `RemoteAuthCredentialStore`, which
 * connects only to `${url}` with its own token.
 *
 * Failure modes: a foreign credential id is 403, never a proxied miss. A shared
 * account's disable never reaches upstream — it queues a policy request, 409s,
 * and re-emits a full snapshot so the requester's optimistic local removal
 * (remote-store.ts:710-717) is undone via the generation-not-older path
 * (remote-store.ts:504-511).
 *
 * Performance: one upstream fetch per worker request; SSE fan-out holds one
 * upstream stream per active worker stream.
 */
import { randomBytes } from "node:crypto";

export interface StartCredentialGatewayOptions {
	/** Base URL of the broker this gateway fronts. */
	upstreamUrl: string;
	/** Admin bearer for the upstream broker. Never exposed to a worker. */
	adminToken: string;
}

export interface IssueWorkerTokenOptions {
	/** Stable worker identity recorded on queued policy requests. */
	workerId: string;
	/** Credential ids this worker may see and act on. */
	credentialIds: number[];
}

export interface WorkerToken {
	token: string;
	workerId: string;
}

export interface PendingPolicyRequest {
	requestId: string;
	credentialId: number;
	workerId: string;
}

export interface CredentialGateway {
	url: string;
	issueWorkerToken(options: IssueWorkerTokenOptions): WorkerToken;
	revokeWorkerToken(token: string): void;
	/** Queued shared-account disables awaiting human policy approval. */
	pendingPolicyRequests(): PendingPolicyRequest[];
	close(): Promise<void>;
}

interface WorkerBinding {
	workerId: string;
	credentialIds: Set<number>;
	/** Monotonic per-worker generation; never derived from upstream numbering. */
	generation: number;
	/** Live SSE writers for this worker. */
	streams: Set<(event: string) => void>;
	/** Conditional long-poll waiters, woken by a generation bump. */
	waiters: Set<() => void>;
}

interface SnapshotBody {
	generation: number;
	credentials: { id: number }[];
	[key: string]: unknown;
}

/**
 * Account identity of one bound credential, mirroring the fields
 * `usageReportMatchesCredential` compares (remote-store.ts:1423-1436).
 * `null` fields mean "the credential asserts nothing here" — an API key
 * carries no account identity at all and therefore matches no report.
 */
export interface BoundIdentity {
	provider: string;
	orgId?: string;
	accountId?: string;
	email?: string;
	projectId?: string;
	/** False for API keys: nothing to match on, so usage stays empty. */
	identifiable: boolean;
}

export interface UsageReportLike {
	provider: string;
	metadata?: Record<string, unknown>;
}

export interface UsageHistoryLike {
	provider: string;
	accountId?: string;
	email?: string;
}

interface SnapshotEntryLike {
	id: number;
	provider: string;
	credential?: {
		type?: string;
		orgId?: string;
		accountId?: string;
		email?: string;
		projectId?: string;
	};
}

const lower = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;

/**
 * Affirmative-match only. A report is attributed to an identity when the org
 * scope agrees AND at least one base identifier matches. An identity with no
 * identifiers (API key) never matches, so an unattributed report is dropped
 * rather than shown to every worker on that provider.
 */
export function reportMatchesIdentity(report: UsageReportLike, identity: BoundIdentity): boolean {
	if (report.provider !== identity.provider) return false;
	if (!identity.identifiable) return false;

	const metadata = report.metadata ?? {};
	if (lower(metadata.orgId) !== identity.orgId) return false;

	for (const [field, expected] of [
		["accountId", identity.accountId],
		["email", identity.email],
		["projectId", identity.projectId],
	] as const) {
		if (expected !== undefined && lower(metadata[field]) === expected) return true;
	}
	return false;
}

/**
 * History rows carry `accountId`/`email` directly. Same affirmative rule:
 * an unidentifiable binding matches nothing.
 */
export function historyMatchesIdentity(entry: UsageHistoryLike, identity: BoundIdentity): boolean {
	if (entry.provider !== identity.provider) return false;
	if (!identity.identifiable) return false;
	if (identity.accountId !== undefined && lower(entry.accountId) === identity.accountId) return true;
	if (identity.email !== undefined && lower(entry.email) === identity.email) return true;
	return false;
}

export async function startCredentialGateway(
	options: StartCredentialGatewayOptions,
): Promise<CredentialGateway> {
	const upstreamUrl = options.upstreamUrl.replace(/\/$/, "");
	const { adminToken } = options;

	const bindings = new Map<string, WorkerBinding>();
	/** Dedupes repeat disables: `${workerId}:${credentialId}` -> request. */
	const pending = new Map<string, PendingPolicyRequest>();

	const upstreamHeaders = (extra?: Record<string, string>): Headers => {
		const headers = new Headers(extra);
		headers.set("Authorization", `Bearer ${adminToken}`);
		return headers;
	};

	const json = (status: number, body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});

	/** Newest upstream generation already reflected in worker views. */
	let lastUpstreamGeneration = 0;

	const upstreamSnapshot = async (): Promise<SnapshotBody> => {
		const res = await fetch(`${upstreamUrl}/v1/snapshot`, { headers: upstreamHeaders() });
		if (!res.ok) throw new Error(`upstream snapshot failed: ${res.status}`);
		return (await res.json()) as SnapshotBody;
	};

	/**
	 * Fetch the upstream snapshot and reduce it to one worker's credentials.
	 * An upstream change advances every worker's view, because
	 * `RemoteAuthCredentialStore` ignores any event whose generation is not
	 * newer than what it already holds (remote-store.ts:504-511).
	 */
	const filteredSnapshot = async (binding: WorkerBinding): Promise<SnapshotBody> => {
		const body = await upstreamSnapshot();
		if (body.generation > lastUpstreamGeneration) {
			lastUpstreamGeneration = body.generation;
			// Advance and notify every worker: an idle worker with no poll in
			// flight would otherwise never learn about an upstream refresh, block,
			// or third-party disable. The already-fetched body is reused so this
			// never re-enters the upstream fetch.
			for (const other of bindings.values()) {
				other.generation += 1;
				for (const wake of [...other.waiters]) wake();
				if (other.streams.size === 0) continue;
				const view = {
					...body,
					generation: other.generation,
					credentials: body.credentials.filter((entry) => other.credentialIds.has(entry.id)),
				};
				const frame = `data: ${JSON.stringify({ kind: "snapshot", ...view })}\n\n`;
				for (const write of other.streams) write(frame);
			}
		}
		return {
			...body,
			generation: binding.generation,
			credentials: body.credentials.filter((entry) => binding.credentialIds.has(entry.id)),
		};
	};

	/**
	 * Account identity of each bound credential, read from the upstream
	 * snapshot. API keys carry no account identity, so they resolve to an
	 * unidentifiable entry and match no usage report.
	 */
	const boundIdentities = async (binding: WorkerBinding): Promise<BoundIdentity[]> => {
		const body = await upstreamSnapshot();
		const identities: BoundIdentity[] = [];
		for (const raw of body.credentials) {
			const entry = raw as SnapshotEntryLike;
			if (!binding.credentialIds.has(entry.id)) continue;
			const credential = entry.credential ?? {};
			const accountId = lower(credential.accountId);
			const email = lower(credential.email);
			const projectId = lower(credential.projectId);
			identities.push({
				provider: entry.provider,
				orgId: lower(credential.orgId),
				accountId,
				email,
				projectId,
				identifiable:
					credential.type === "oauth" &&
					(accountId !== undefined || email !== undefined || projectId !== undefined),
			});
		}
		return identities;
	};

	/**
	 * Advance a worker's view, then push a full filtered snapshot to its streams
	 * and wake its conditional long-polls. A full snapshot (not a delta) is what
	 * lets a store that already removed a credential locally take it back.
	 */
	const bumpAndBroadcast = async (binding: WorkerBinding): Promise<void> => {
		binding.generation += 1;
		for (const wake of [...binding.waiters]) wake();
		if (binding.streams.size === 0) return;
		const snapshot = await filteredSnapshot(binding);
		const frame = `data: ${JSON.stringify({ kind: "snapshot", ...snapshot })}\n\n`;
		for (const write of binding.streams) write(frame);
	};

	/** Resolve once this worker's generation moves past `seen`, or on timeout. */
	const waitForGeneration = (binding: WorkerBinding, seen: number, waitMs: number): Promise<void> => {
		if (binding.generation > seen) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = () => {
			clearTimeout(timer);
			binding.waiters.delete(wake);
			resolve();
		};
		const timer = setTimeout(wake, waitMs);
		binding.waiters.add(wake);
		return promise;
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const path = url.pathname;

			if (path === "/v1/healthz") {
				return await fetch(`${upstreamUrl}/v1/healthz`);
			}

			const auth = req.headers.get("Authorization");
			const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
			const binding = token ? bindings.get(token) : undefined;
			// The admin token is deliberately not accepted here: workers reach the
			// gateway, operators reach the broker.
			if (!binding) return json(401, { error: "unauthorized" });

			if (path === "/v1/snapshot") {
				// Conditional long-poll: hold while the worker's view is unchanged,
				// so a synthetic generation bump wakes it the same way SSE does.
				const ifNoneMatch = req.headers.get("If-None-Match");
				const seen = ifNoneMatch ? Number(ifNoneMatch.replace(/"/g, "")) : Number.NaN;
				const waitSeconds = Number(url.searchParams.get("wait") ?? "0");
				if (Number.isFinite(seen) && waitSeconds > 0) {
					await waitForGeneration(binding, seen, waitSeconds * 1_000);
					if (binding.generation <= seen) {
						return new Response(null, { status: 304, headers: { ETag: `"${binding.generation}"` } });
					}
				}

				const snapshot = await filteredSnapshot(binding);
				if (Number.isFinite(seen) && snapshot.generation === seen) {
					return new Response(null, { status: 304, headers: { ETag: `"${snapshot.generation}"` } });
				}
				return new Response(JSON.stringify(snapshot), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						ETag: `"${snapshot.generation}"`,
					},
				});
			}

			if (path === "/v1/snapshot/stream") {
				const snapshot = await filteredSnapshot(binding);
				let write: ((event: string) => void) | undefined;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const encoder = new TextEncoder();
						write = (event) => {
							try {
								controller.enqueue(encoder.encode(event));
							} catch {
								// Receiver hung up between broadcast and write.
							}
						};
						binding.streams.add(write);
						write(`data: ${JSON.stringify({ kind: "snapshot", ...snapshot })}\n\n`);
					},
					cancel() {
						if (write) binding.streams.delete(write);
					},
				});
				return new Response(stream, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			}

			const credentialRoute = /^\/v1\/credential\/(\d+)\/(refresh|block|disable)$/.exec(path);
			if (credentialRoute) {
				const credentialId = Number(credentialRoute[1]);
				const action = credentialRoute[2];
				if (!binding.credentialIds.has(credentialId)) {
					return json(403, { error: "credential not bound to this worker" });
				}

				if (action !== "disable") {
					return await fetch(`${upstreamUrl}${path}`, {
						method: "POST",
						headers: upstreamHeaders({ "Content-Type": "application/json" }),
						body: await req.text(),
					});
				}

				// Disable: shared accounts need human policy, dedicated ones proxy.
				const sharedWith = [...bindings.values()].filter((other) =>
					other.credentialIds.has(credentialId),
				);
				const isShared = new Set(sharedWith.map((other) => other.workerId)).size > 1;
				if (!isShared) {
					return await fetch(`${upstreamUrl}${path}`, {
						method: "POST",
						headers: upstreamHeaders({ "Content-Type": "application/json" }),
						body: await req.text(),
					});
				}

				const key = `${binding.workerId}:${credentialId}`;
				let request = pending.get(key);
				if (!request) {
					request = {
						requestId: randomBytes(12).toString("base64url"),
						credentialId,
						workerId: binding.workerId,
					};
					pending.set(key, request);
				}
				// Upstream is untouched; only this worker's view moves, and it
				// receives a full snapshot so its optimistic removal is undone.
				await bumpAndBroadcast(binding);
				return json(409, { status: "pending_policy", requestId: request.requestId });
			}

			// Usage stays reachable — stock `RemoteAuthCredentialStore` calls it for
			// ranking and quota signals (remote-store.ts:1071) — but aggregate and
			// history responses are reduced to the worker's own accounts.
			if (path === "/v1/usage" || path === "/v1/usage/history") {
				const res = await fetch(`${upstreamUrl}${path}${url.search}`, {
					headers: upstreamHeaders(),
				});
				if (!res.ok) return res;

				const identities = await boundIdentities(binding);
				const body = (await res.json()) as Record<string, unknown>;
				if (path === "/v1/usage") {
					const reports = (body.reports as UsageReportLike[] | undefined) ?? [];
					body.reports = reports.filter((report) =>
						identities.some((identity) => reportMatchesIdentity(report, identity)),
					);
				} else {
					const entries = (body.entries as UsageHistoryLike[] | undefined) ?? [];
					body.entries = entries.filter((entry) =>
						identities.some((identity) => historyMatchesIdentity(entry, identity)),
					);
				}
				return json(200, body);
			}

			// Per-install burn aggregates span every client; admin-only.
			if (path === "/v1/usage/clients") {
				return json(403, { error: "admin only" });
			}

			// Observed-usage reporting is a write of the worker's own numbers, so it
			// carries no cross-account read and stays available.
			if (path === "/v1/usage/observed") {
				return await fetch(`${upstreamUrl}${path}`, {
					method: req.method,
					headers: upstreamHeaders({ "Content-Type": "application/json" }),
					body: await req.text(),
				});
			}

			// Credential upload and every unenumerated route stay admin-only.
			return json(403, { error: "admin only" });
		},
	});

	let closed = false;
	return {
		url: `http://${server.hostname}:${server.port}`,
		issueWorkerToken: ({ workerId, credentialIds }) => {
			const token = randomBytes(32).toString("base64url");
			bindings.set(token, {
				workerId,
				credentialIds: new Set(credentialIds),
				generation: 1,
				streams: new Set(),
				waiters: new Set(),
			});
			return { token, workerId };
		},
		revokeWorkerToken: (token) => {
			bindings.delete(token);
		},
		pendingPolicyRequests: () => [...pending.values()],
		close: async () => {
			if (closed) return;
			closed = true;
			bindings.clear();
			await server.stop(true);
		},
	};
}
