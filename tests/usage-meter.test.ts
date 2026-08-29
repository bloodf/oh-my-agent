/**
 * RED tests for T-1002: usage feeds the meter.
 *
 * Public API under test: `bootDaemon(options)` — specifically the account→
 * credential binding at spawn and the usage-polling loop that drives
 * `AccountRegistry.updateMeter`, so the T-506 warn(80%)/park(100%) flow fires on
 * real reported usage rather than never.
 *
 * The seam these tests drive:
 *  - `bootDaemon` accepts `fetchUpstream` (injected broker transport, the same
 *    seam `startCredentialGateway` already exposes) so a fixture can serve the
 *    `/v1/snapshot` and `/v1/usage` bodies both the gateway and the daemon read.
 *  - `bootDaemon` accepts `onUsagePoller`, handing back a `{ pollOnce }` handle so
 *    a test can step the loop deterministically instead of waiting on a timer;
 *    `usagePollMs` is set huge so the interval never fires on its own.
 *
 * The worker is a stub following `SupervisedWorker` (the pattern in
 * tests/daemon-main.test.ts). A metered account's warning is posted into the
 * peer's room and delivered to it as a prompt, so the running peer's `prompts`
 * are the observable — exactly as tests/supervisor.test.ts asserts.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import type { SupervisedWorker } from "../src/daemon/supervisor";

// ── Cleanup ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-usage-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Write a peer into the private store plus the task agent its `spawns:` names.
 * Both are required: the parser rejects an empty `spawns:` and the daemon
 * refuses to start a peer whose spawn closure it cannot resolve.
 */
async function writePeer(
	agentDir: string,
	name: string,
	frontmatter: Record<string, unknown>,
): Promise<void> {
	const taskAgents = join(agentDir, "agents");
	await mkdir(taskAgents, { recursive: true });
	await writeFile(
		join(taskAgents, "scout.md"),
		'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
		"utf8",
	);

	const root = join(agentDir, "oh-my-agent", "agents");
	await mkdir(root, { recursive: true });
	const yaml = Object.entries({
		name,
		description: `${name} peer.`,
		spawns: ["scout"],
		...frontmatter,
	})
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	await writeFile(
		join(root, `${name}.md`),
		`---\n${yaml}\n---\nYou are ${name}.\n`,
		"utf8",
	);
}

interface StubWorker {
	prompts: string[];
	state: () => SupervisedWorker["state"];
}

function stubFactory(): {
	factory: WorkerFactory;
	workers: Map<string, StubWorker>;
} {
	const workers = new Map<string, StubWorker>();
	const factory: WorkerFactory = async ({ peer }) => {
		const prompts: string[] = [];
		let state: SupervisedWorker["state"] = "running";
		workers.set(peer.name, { prompts, state: () => state });
		return {
			name: peer.name,
			get state() {
				return state;
			},
			prompt: async (message: string) => {
				prompts.push(message);
			},
			park: async () => {
				state = "parked";
			},
			resume: async () => {
				state = "running";
			},
			stop: async () => {
				state = "stopped";
			},
		};
	};
	return { factory, workers };
}

/**
 * In-memory upstream broker: one OAuth credential per provider and a `/v1/usage`
 * body whose openai `usd` limit the test drives. Records the `provider` query of
 * every usage fetch so a test can assert a provider was never polled.
 */
function fakeUpstream() {
	let openaiUsed = 0;
	const usageProviderCalls: (string | null)[] = [];
	const snapshot = {
		generation: 7,
		credentials: [
			{
				id: 1,
				provider: "openai",
				credential: {
					type: "oauth",
					accountId: "acct-openai",
					email: "dev-openai@example.com",
				},
			},
			{
				id: 2,
				provider: "anthropic",
				credential: {
					type: "oauth",
					accountId: "acct-anthropic",
					email: "dev-anthropic@example.com",
				},
			},
		],
	};

	const json = (value: unknown) =>
		new Response(JSON.stringify(value), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

	const fetchUpstream = async (
		input: string,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(String(input));
		const path = url.pathname;

		if (path === "/v1/snapshot") {
			const seen = new Headers(init?.headers).get("If-None-Match");
			if (seen === `"${snapshot.generation}"`) {
				return new Response(null, { status: 304 });
			}
			return json(snapshot);
		}

		if (path === "/v1/usage") {
			usageProviderCalls.push(url.searchParams.get("provider"));
			return json({
				generatedAt: 1,
				reports: [
					{
						provider: "openai",
						fetchedAt: 1,
						metadata: {
							accountId: "acct-openai",
							email: "dev-openai@example.com",
						},
						limits: [
							{
								id: "monthly",
								label: "Monthly",
								scope: { provider: "openai" },
								amount: { used: openaiUsed, limit: 10, unit: "usd" },
							},
						],
					},
					{
						provider: "anthropic",
						fetchedAt: 1,
						metadata: {
							accountId: "acct-anthropic",
							email: "dev-anthropic@example.com",
						},
						limits: [
							{
								id: "monthly",
								label: "Monthly",
								scope: { provider: "anthropic" },
								amount: { used: 9, limit: 10, unit: "usd" },
							},
						],
					},
				],
			});
		}

		return new Response("not found", { status: 404 });
	};

	return {
		fetchUpstream,
		usageProviderCalls,
		setOpenaiUsed: (value: number) => {
			openaiUsed = value;
		},
	};
}

interface Booted {
	handle: DaemonHandle;
	workers: Map<string, StubWorker>;
	fake: ReturnType<typeof fakeUpstream>;
	pollOnce: () => Promise<void>;
}

async function boot(
	peers: { name: string; frontmatter: Record<string, unknown> }[],
): Promise<Booted> {
	const agentDir = await tempDir();
	const projectDir = await tempDir();
	for (const peer of peers)
		await writePeer(agentDir, peer.name, peer.frontmatter);

	const stub = stubFactory();
	const fake = fakeUpstream();
	let pollOnce: (() => Promise<void>) | undefined;

	const handle = await bootDaemon({
		env: {},
		agentDir,
		projectDir,
		workerFactory: stub.factory,
		fetchUpstream: fake.fetchUpstream,
		// Large enough that the interval never fires on its own; the tests step
		// the loop through the captured handle.
		usagePollMs: 3_600_000,
		onUsagePoller: (poller) => {
			pollOnce = () => poller.pollOnce();
		},
	});
	cleanups.push(() => handle.close());

	if (!pollOnce) throw new Error("bootDaemon never handed back a usage poller");
	return { handle, workers: stub.workers, fake, pollOnce };
}

const OPENAI_METERED = {
	name: "reviewer",
	frontmatter: {
		model: "openai/gpt-5",
		rooms: ["#reviews"],
		autonomy: { budgetUsd: 10 },
	},
};

const ANTHROPIC_SUBSCRIPTION = {
	name: "researcher",
	frontmatter: {
		model: "anthropic/claude-sonnet-4-5",
		rooms: ["#research"],
	},
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("usage feeds the meter", () => {
	test("reported usage moves the meter and 80% warns naming account and budget", async () => {
		const b = await boot([OPENAI_METERED]);
		b.fake.setOpenaiUsed(8); // 8 / 10 = 0.8

		await b.pollOnce();

		const prompts = b.workers.get("reviewer")?.prompts ?? [];
		expect(
			prompts.filter((p) =>
				p.includes("Metered account openai reached 80% of its $10 budget."),
			),
		).toHaveLength(1);
	});

	test("reaching the cap parks the account's runs", async () => {
		const b = await boot([OPENAI_METERED]);
		b.fake.setOpenaiUsed(10); // 10 / 10 = 1.0

		await b.pollOnce();

		// Reaching the cap parks the run. The exhausted-budget notice posts into
		// the account room, but a parked peer is not prompted with it, so parking
		// is the observable a stub worker exposes — and only movement to the cap
		// produces it.
		expect(b.workers.get("reviewer")?.state()).toBe("parked");
	});

	test("a subscription account's meter never moves", async () => {
		const b = await boot([OPENAI_METERED, ANTHROPIC_SUBSCRIPTION]);
		b.fake.setOpenaiUsed(8);

		await b.pollOnce();

		// The subscription account is never polled and never warned, even though
		// its fixture usage sits at 90%.
		expect(b.fake.usageProviderCalls).not.toContain("anthropic");
		expect(b.workers.get("researcher")?.state()).toBe("running");
		expect(
			(b.workers.get("researcher")?.prompts ?? []).some((p) =>
				p.includes("reached 80%"),
			),
		).toBe(false);
	});

	test("polling stops when no peer on the account is running", async () => {
		const b = await boot([OPENAI_METERED]);
		b.fake.setOpenaiUsed(10);

		// First poll parks the peer at the cap.
		await b.pollOnce();
		expect(b.workers.get("reviewer")?.state()).toBe("parked");
		const callsAfterPark = b.fake.usageProviderCalls.length;
		expect(callsAfterPark).toBeGreaterThan(0);

		// With nothing running on the account, a further poll makes no fetch.
		await b.pollOnce();
		expect(b.fake.usageProviderCalls.length).toBe(callsAfterPark);
	});

	test("the account's worker token is bound to its provider credentials", async () => {
		// Binding is what makes usage visible: an unbound token sees no reports,
		// so the meter never moves. A moving meter at 80% proves the openai peer's
		// token was bound to the openai credential from the snapshot.
		const b = await boot([OPENAI_METERED]);
		b.fake.setOpenaiUsed(8);

		await b.pollOnce();

		expect(b.fake.usageProviderCalls).toContain("openai");
		expect(
			(b.workers.get("reviewer")?.prompts ?? []).some((p) =>
				p.includes("reached 80%"),
			),
		).toBe(true);
	});

	test("a bump raises the poll denominator so a resumed account does not re-park", async () => {
		// Regression: the poller divides burn by the account's budget. A bump
		// raises that ceiling through the socket; if the poller kept dividing by
		// the pre-bump budget, the very next poll would re-park the account the
		// operator just resumed.
		const b = await boot([OPENAI_METERED]);
		b.fake.setOpenaiUsed(10); // 10 / 10 = 1.0 → park at the cap.

		await b.pollOnce();
		expect(b.workers.get("reviewer")?.state()).toBe("parked");

		// Bump the ceiling to $20; burn is still $10, so the meter should read 0.5.
		const account = await bumpTo(b.handle.socketPath, 20);
		expect(account).toBe("openai");
		expect(b.workers.get("reviewer")?.state()).toBe("running");

		await b.pollOnce();
		expect(b.workers.get("reviewer")?.state()).toBe("running");
	});
});

/** Resolve the metered account id the daemon assigned, then bump its budget. */
async function bumpTo(socketPath: string, budgetUsd: number): Promise<string> {
	const status = (await rpc(socketPath, "agent_status", {
		name: "reviewer",
	})) as { result?: { agents?: { account?: string }[] } };
	const account = status.result?.agents?.[0]?.account ?? "";
	if (account.length === 0) throw new Error("no account on reviewer status");
	await rpc(socketPath, "bump", { account, budgetUsd });
	return account;
}

/** One JSON-RPC round trip over the daemon's unix socket. */
async function rpc(
	socketPath: string,
	method: string,
	params?: unknown,
): Promise<unknown> {
	const res = await fetch("http://localhost/rpc", {
		unix: socketPath,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return await res.json();
}
