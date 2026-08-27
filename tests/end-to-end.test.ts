/**
 * End-to-end integration: spawn → room message → delegate → park → auto-resume.
 *
 * Every module has unit coverage; what this suite proves is that they compose
 * into the behavior §4 promises — an agent that keeps working while nobody is
 * watching. A room message wakes a materialized worker, the worker delegates
 * through native `task`, a quota block parks the run, and the armed timer
 * resumes it without a human.
 *
 * The model is a deterministic loopback pi-native gateway; everything else is
 * real: real materialized worker dirs, a real RPC subprocess, a real SQLite
 * room store, and the real scheduler/registry.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AccountRegistry } from "../src/daemon/account-registry";
import { materializeWorker } from "../src/daemon/materializer";
import type { WorkerLayout } from "../src/daemon/materializer";
import { Supervisor } from "../src/daemon/supervisor";
import { Scheduler } from "../src/daemon/scheduler";
import type { QuotaBlock } from "../src/daemon/quota-state";
import { RoomStore } from "../src/rooms/store";
import { parsePeerDefinition } from "../src/shared/agent-definition";
import type { PeerDefinition } from "../src/shared/agent-definition";
import { startWorker } from "../src/worker/lifecycle";
import type { WorkerHandle } from "../src/worker/lifecycle";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

type ScriptTurn = { tool: string; arguments: Record<string, unknown> } | { text: string };

/** Deterministic pi-native gateway (see pi-native-server.ts:21-24). */
async function fakeInference(script: ScriptTurn[]): Promise<{ url: string; token: string }> {
	let turn = 0;

	const assistant = (content: unknown[], stopReason: string) => ({
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "oh-my-agent",
		model: "fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	});

	const events = (step: ScriptTurn): unknown[] => {
		const base = assistant([], "stop");
		if ("tool" in step) {
			const toolCall = {
				type: "toolCall",
				id: `call-${turn}`,
				name: step.tool,
				arguments: step.arguments,
			};
			const partial = { ...base, content: [toolCall], stopReason: "toolUse" };
			return [
				{ type: "start", partial: base },
				{ type: "toolcall_start", contentIndex: 0, partial },
				{ type: "toolcall_end", contentIndex: 0, toolCall, partial },
				{ type: "done", reason: "toolUse", message: partial },
			];
		}
		const content = [{ type: "text", text: step.text }];
		const partial = { ...base, content, stopReason: "stop" };
		return [
			{ type: "start", partial: base },
			{ type: "text_start", contentIndex: 0, partial },
			{ type: "text_delta", contentIndex: 0, delta: step.text, partial },
			{ type: "text_end", contentIndex: 0, content: step.text, partial },
			{ type: "done", reason: "stop", message: partial },
		];
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			if (new URL(req.url).pathname !== "/v1/pi/stream") {
				return new Response("not found", { status: 404 });
			}
			const step = script[Math.min(turn, script.length - 1)];
			turn += 1;
			const frames = events(step)
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			return new Response(`${frames}data: [DONE]\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	cleanups.push(async () => {
		await server.stop(true);
	});

	return { url: `http://${server.hostname}:${server.port}`, token: "worker-token" };
}

function peer(frontmatter: Record<string, unknown> = {}): PeerDefinition {
	const yaml = Object.entries({
		name: "reviewer",
		description: "Reviews PRs.",
		model: "anthropic/claude-sonnet-4-5",
		tools: ["read", "grep"],
		spawns: ["scout"],
		rooms: ["#reviews"],
		...frontmatter,
	})
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return parsePeerDefinition("/agents/reviewer.md", `---\n${yaml}\n---\nYou are the reviewer.`);
}

/** A full daemon slice: rooms, scheduler, registry, and a spawned worker. */
async function daemon(script: ScriptTurn[], overrides: Record<string, unknown> = {}) {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-e2e-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));
	await writeFile(join(base, "README.md"), "# fixture\n", "utf8");

	const rooms = await RoomStore.open(join(base, "rooms.db"));
	cleanups.push(() => rooms.close());

	const parsedPeer = peer(overrides);
	const layout: WorkerLayout = await materializeWorker({
		rootDir: join(base, "worker"),
		parsedPeer,
		discoveredAgentNames: ["other-agent"],
		inferenceGateway: await fakeInference(script),
		sourceSpawnAgents: {
			scout: `---\nname: scout\ndescription: Reads code.\n---\nYou are a scout.`,
		},
	});

	// Injected clock so quota deadlines are exercised without real waiting.
	let now = 1_000_000;
	const timers: { delayMs: number; callback: () => void }[] = [];
	const scheduler = new Scheduler({
		now: () => now,
		setTimer: (callback, delayMs) => {
			timers.push({ delayMs, callback });
			return timers.length;
		},
		clearTimer: () => {},
	});
	scheduler.start();

	const supervisor = new Supervisor({ rooms, scheduler, now: () => now });

	return {
		base,
		rooms,
		supervisor,
		timers,
		parsedPeer,
		layout,
		advanceTo: (ms: number) => {
			now = ms;
		},
		/** Spawn the peer and hand it to the supervisor, as the daemon does. */
		async spawn(): Promise<WorkerHandle> {
			const handle = await startWorker({ peer: parsedPeer, layout, cwd: base });
			cleanups.push(() => handle.stop());
			await supervisor.register({
				worker: handle,
				accountId: "acct-1",
				mode: "subscription",
				rooms: parsedPeer.rooms ?? [],
			});
			return handle;
		},
	};
}

// ── The full flow ────────────────────────────────────────────────────────────

describe("spawn → room message → delegate → park → auto-resume", () => {
	test("a room message wakes a worker that delegates through native task", async () => {
		const d = await daemon([
			{ tool: "task", arguments: { agent: "scout", prompt: "Read README.md" } },
			{ text: "Reviewed." },
		]);
		const worker = await d.spawn();
		const dispatched: string[] = [];
		worker.onToolCall((name) => dispatched.push(name));

		// A human posts. Nothing else in this test drives the worker.
		const woken = await d.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Please review the README.",
		});
		expect(woken).toEqual(["reviewer"]);

		// §5.1: coding subtasks go through native `task`, never `agent_spawn`.
		expect(dispatched).toContain("task");
		expect(dispatched).not.toContain("agent_spawn");

		// The cursor advanced, so the same message never re-fires.
		expect(await d.supervisor.deliver("reviewer")).toBe(false);
	});

	test("a quota block parks the worker and auto-resume delivers the backlog", async () => {
		const d = await daemon([{ text: "Reviewed." }, { text: "Caught up." }]);
		await d.rooms.createRoom({ id: "#reviews", kind: "channel" });
		const worker = await d.spawn();

		const block: QuotaBlock = {
			credentialId: 7,
			providerKey: "anthropic",
			scope: "account",
			blockedUntilMs: 1_000_000 + 900_000,
		};
		await d.supervisor.applyBlock("acct-1", block);
		await d.supervisor.settled();

		// The worker itself is parked, not merely the account row.
		expect(worker.state).toBe("parked");
		// Posting through the daemon path: a parked peer is skipped, and the
		// message waits rather than burning a turn that would fail.
		expect(
			await d.supervisor.post({ room: "#reviews", author: "@you", body: "While parked." }),
		).toEqual([]);

		// The daemon armed a one-shot from the verified deadline; no human acts.
		expect(d.timers).toHaveLength(1);
		expect(d.timers[0].delayMs).toBe(900_000);

		d.advanceTo(block.blockedUntilMs);
		d.timers[0].callback();
		await d.supervisor.settled();

		// The timer alone restarted the worker AND delivered the backlog.
		expect(worker.state).toBe("running");
		expect(await d.supervisor.deliver("reviewer")).toBe(false);
	});

	test("a parked worker resumes as a fresh session and still delegates", async () => {
		const d = await daemon([
			{ tool: "task", arguments: { agent: "scout", prompt: "Read README.md" } },
			{ text: "Reviewed." },
		]);

		const worker = await d.spawn();
		const firstSession = worker.sessionId;

		// §10.3: park drops the process; policy files never mutate under a live
		// one, so resume starts a fresh session against the same layout.
		await worker.park();
		expect(worker.state).toBe("parked");
		await worker.resume();

		expect(worker.state).toBe("running");
		expect(worker.sessionId).not.toBe(firstSession);
		expect(worker.fingerprint).toBe(d.layout.definitionFingerprint);

		const dispatched: string[] = [];
		worker.onToolCall((name) => dispatched.push(name));
		await worker.prompt("Review again.");
		expect(dispatched).toContain("task");
	});

	test("the worker's view is confined to its spawns closure", async () => {
		const d = await daemon([{ text: "ok" }]);
		const worker = await d.spawn();

		// Defense in depth (§5.2): every discovered agent outside the allowlist
		// is denied, and the worker's tool surface keeps native delegation.
		expect(d.layout.disabledAgents).toEqual(["other-agent"]);
		const tools = await worker.effectiveTools();
		expect(tools).toContain("task");
		expect(tools).not.toContain("agent_spawn");
	});

	test("the worker carries only its gateway token", async () => {
		const d = await daemon([{ text: "ok" }]);
		const worker = await d.spawn();

		expect(worker.env.OH_MY_AGENT_INFERENCE_TOKEN).toBe("worker-token");
		const leaked = Object.keys(worker.env).filter(
			(key) =>
				key !== "OH_MY_AGENT_INFERENCE_TOKEN" &&
				/OMP_AUTH_BROKER|ANTHROPIC_API_KEY|OPENAI_API_KEY/i.test(key),
		);
		expect(leaked).toEqual([]);
	});

	test("a peer's own room posts never wake it", async () => {
		const d = await daemon([{ text: "ok" }]);
		await d.rooms.createRoom({ id: "#reviews", kind: "channel" });
		await d.spawn();

		// An agent that summarizes into its own room would otherwise re-wake
		// itself forever.
		await d.rooms.post({ room: "#reviews", author: "reviewer", body: "My summary." });

		expect(await d.supervisor.deliver("reviewer")).toBe(false);
	});
});
