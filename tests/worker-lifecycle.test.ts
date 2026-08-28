/**
 * RED tests for src/worker/lifecycle.ts
 *
 * Public API under test:
 *   startWorker(options) -> WorkerHandle   (§9.1 RPC subprocess lifecycle)
 *   resolveWorkerTools(peer, opts)         (§5.1 effective tool list)
 *   classifyAgentSpawn(payload)            (§5.1 two spawn verbs)
 *
 * §9.1: the worker is a long-lived OMP RPC subprocess, driven through OMP's own
 * `RpcClient`. The daemon owns its lifecycle (start / prompt / park / resume /
 * stop) and wires it to the materialized worker dir (§5.2) — synthetic HOME,
 * all four XDG dirs, `PI_CODING_AGENT_DIR`, and the per-worker inference token
 * from the credential gateway (§9.6). No upstream broker credential ever
 * reaches the child env.
 *
 * §5.1 is asserted against the real child: its effective tool list must contain
 * `task` even when `tools:` omits it, because OMP appends it when `spawns:` is
 * declared and depth permits (executor.ts:2836-2848).
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeWorker } from "../src/daemon/materializer";
import type { PeerDefinition } from "../src/shared/agent-definition";
import { parsePeerDefinition } from "../src/shared/agent-definition";
import { resolveSandboxLaunch } from "../src/worker/launch-gate";
import type { WorkerHandle } from "../src/worker/lifecycle";
import { classifyAgentSpawn, startWorker } from "../src/worker/lifecycle";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const GATEWAY = {
	url: "http://127.0.0.1:9999",
	token: "worker-token",
} as const;

function peer(frontmatter: Record<string, unknown> = {}): PeerDefinition {
	const yaml = Object.entries({
		name: "reviewer",
		description: "Reviews PRs.",
		model: "anthropic/claude-sonnet-4-5",
		spawns: ["scout"],
		...frontmatter,
	})
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return parsePeerDefinition(
		"/agents/reviewer.md",
		`---\n${yaml}\n---\nYou are the reviewer.`,
	);
}

/** One scripted assistant turn: either a tool call or final text. */
type ScriptTurn =
	| { tool: string; arguments: Record<string, unknown> }
	| { text: string };

/**
 * Minimal pi-native gateway. The worker's models.yml sets
 * `transport: pi-native` with this loopback baseUrl, so the child performs real
 * turns against a deterministic model.
 *
 * Wire contract (pi-native-server.ts:21-24): `POST /v1/pi/stream` answers with
 * an SSE stream of canonical `AssistantMessageEvent`s terminated by
 * `data: [DONE]`.
 */

async function fakeInference(
	script: ScriptTurn[],
): Promise<{ url: string; token: string }> {
	let turn = 0;

	// Canonical zero-usage AssistantMessage, mirroring pi-ai's own
	// `makeSyntheticAssistant` (pi-native-client.ts:265-283). `api` is the
	// model's api — `pi-native` is the transport, not an api.
	const assistant = (content: unknown[], stopReason: string) => ({
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "oh-my-agent",
		model: "fake-model",
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
				{
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify(step.arguments),
					partial,
				},
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
			const { pathname } = new URL(req.url);
			if (pathname !== "/v1/pi/stream")
				return new Response("not found", { status: 404 });

			const step = script[Math.min(turn, script.length - 1)];
			turn += 1;
			const frames = events(step)
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");

			return new Response(`${frames}data: [DONE]\n\n`, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
			});
		},
	});
	cleanups.push(async () => {
		await server.stop(true);
	});

	return {
		url: `http://${server.hostname}:${server.port}`,
		token: "worker-token",
	};
}

/** A materialized worker dir plus a project cwd, as the daemon would build them. */
async function workerFixture(
	overrides: Record<string, unknown> = {},
	script?: ScriptTurn[],
) {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-wl-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));

	await writeFile(join(base, "README.md"), "# fixture\n", "utf8");

	const inferenceGateway = script ? await fakeInference(script) : GATEWAY;
	const parsedPeer = peer(overrides);
	const layout = await materializeWorker({
		rootDir: join(base, "worker"),
		parsedPeer,
		discoveredAgentNames: ["other-agent"],
		inferenceGateway,
		sourceSpawnAgents: {
			scout: `---\nname: scout\ndescription: Reads code.\n---\nYou are a scout.`,
		},
	});

	return { base, cwd: base, parsedPeer, layout };
}

/**
 * A runnable stand-in for `sandbox-exec`: consumes `-p <profile>`, execs the
 * payload. Lets a real gate result run without a privileged sandbox.
 */
async function passthroughAdapter(root: string): Promise<string> {
	const path = join(root, "passthrough-adapter");
	await writeFile(
		path,
		["#!/bin/sh", 'if [ "$1" = "-p" ]; then shift 2; fi', 'exec "$@"', ""].join(
			"\n",
		),
		{ encoding: "utf8", mode: 0o755 },
	);
	return path;
}

async function start(
	overrides: Record<string, unknown> = {},
	script?: ScriptTurn[],
): Promise<WorkerHandle> {
	const { cwd, parsedPeer, layout } = await workerFixture(overrides, script);
	const handle = await startWorker({ peer: parsedPeer, layout, cwd });
	cleanups.push(() => handle.stop());
	return handle;
}

// ── RPC subprocess lifecycle (§9.1) ─────────────────────────────────────────

describe("worker lifecycle", () => {
	test("starts a real child process in the running state", async () => {
		const handle = await start();

		expect(handle.state).toBe("running");
		expect(handle.name).toBe("reviewer");
		expect(handle.sessionId).toBeTruthy();
	});

	test("runs inside the materialized worker dir", async () => {
		const handle = await start();

		expect(handle.env.HOME).toBe(handle.layout.home);
		expect(handle.env.PI_CODING_AGENT_DIR).toBe(handle.layout.agentDir);
		expect(handle.env.XDG_CONFIG_HOME).toBe(
			join(handle.layout.home, ".config"),
		);
	});

	test("carries the gateway token and no upstream credentials", async () => {
		const handle = await start();

		expect(handle.env.OH_MY_AGENT_INFERENCE_TOKEN).toBe(GATEWAY.token);
		const leaked = Object.keys(handle.env).filter(
			(key) =>
				key !== "OH_MY_AGENT_INFERENCE_TOKEN" &&
				/OMP_AUTH_BROKER|ANTHROPIC_API_KEY|OPENAI_API_KEY/i.test(key),
		);
		expect(leaked).toEqual([]);
	});

	test("park stops the process but keeps the fingerprint", async () => {
		const handle = await start();
		const { fingerprint } = handle;

		await handle.park();

		expect(handle.state).toBe("parked");
		expect(handle.fingerprint).toBe(fingerprint);
		expect(handle.sessionId).toBeUndefined();
	});

	test("a parked worker resumes as a fresh process", async () => {
		const handle = await start();
		const firstSession = handle.sessionId;

		await handle.park();
		await handle.resume();

		expect(handle.state).toBe("running");
		expect(handle.sessionId).toBeTruthy();
		expect(handle.sessionId).not.toBe(firstSession);
	});

	test("stop is idempotent and terminal", async () => {
		const handle = await start();
		await handle.stop();
		await handle.stop();

		expect(handle.state).toBe("stopped");
		expect(handle.sessionId).toBeUndefined();
	});

	test("a stopped worker refuses prompts and resumes", async () => {
		const handle = await start();
		await handle.stop();
		await expect(handle.prompt("anything")).rejects.toThrow();
		await expect(handle.resume()).rejects.toThrow();
	});
});

// ── §5.1 delegation contract, asserted against the live child ───────────────

describe("§5.1 delegation contract", () => {
	test("a restricted tools list still exposes native task", async () => {
		const handle = await start({ tools: ["read", "grep"] });

		// OMP appends `task` when `spawns:` is declared and depth permits, so a
		// naive `tools:` list must not silently strip delegation.
		const tools = await handle.effectiveTools();
		expect(tools).toContain("task");
		expect(tools).toContain("read");
	});

	test("the worker's agent dir allows only its spawns closure", async () => {
		const handle = await start({ tools: ["read"] });

		expect(handle.layout.disabledAgents).toEqual(["other-agent"]);
	});

	test("agent_spawn is not part of the worker's in-run tool surface", async () => {
		const handle = await start({ tools: ["read", "grep"] });

		// Durable peers are created through the daemon toolbelt, never as an
		// in-run OMP tool; coding subtasks must route through native `task`.
		expect(await handle.effectiveTools()).not.toContain("agent_spawn");
	});

	test("a prompted worker delegates through native task and never agent_spawn", async () => {
		// Deterministic model: the first turn requests native `task`, the second
		// finishes. Nothing about the tool surface is asserted from our own
		// re-implementation — these are the child's real tool events.
		const handle = await start({ tools: ["read", "grep"] }, [
			{ tool: "task", arguments: { agent: "scout", prompt: "Read README.md" } },
			{ text: "Summarized." },
		]);

		const dispatched: string[] = [];
		handle.onToolCall((name) => dispatched.push(name));

		await handle.prompt(
			"Summarize README.md, delegating the read to a subagent.",
		);

		expect(dispatched).toContain("task");
		expect(dispatched).not.toContain("agent_spawn");
	});
});

// ── Sandbox wiring (§7) ──────────────────────────────────────────────────────

describe("sandbox wiring", () => {
	test("a sandboxed worker actually runs under the resolved argv", async () => {
		const { cwd, layout } = await workerFixture({}, [{ text: "ok" }]);
		// Stand-in for sandbox-exec: records the payload it was handed, then
		// execs it. If the shim bypassed the gate, this file never appears.
		const marker = join(layout.root, "sandbox-invoked");
		const wrapper = join(layout.root, "fake-sandbox");
		await writeFile(
			wrapper,
			[
				"#!/bin/sh",
				"# Stand-in for sandbox-exec: consumes `-p <profile>`, records the",
				"# payload, then execs it.",
				'if [ "$1" = "-p" ]; then shift 2; fi',
				`printf '%s' "$*" > ${JSON.stringify(marker)}`,
				'exec "$@"',
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);
		// Drive the real gate, then swap only the adapter binary for the fake
		// wrapper: the argv structure — profile flags and payload ordering — is
		// the gate's own output, not something this test reassembled.
		const realCli = fileURLToPath(
			import.meta.resolve("@oh-my-pi/pi-coding-agent/package.json"),
		).replace(/package\.json$/, "dist/cli.js");
		const gated = await resolveSandboxLaunch({
			policy: {
				workspace: cwd,
				workerHome: layout.home,
				runtimePaths: ["/usr/bin", "/bin"],
				inferenceGateway: { host: "127.0.0.1", port: 9999 },
				loopbackPorts: [9999],
			},
			command: ["bun", realCli],
			platform: "darwin",
			which: async () => "/usr/bin/sandbox-exec",
			probeBridge: async () => true,
			// Only the adapter binary is substituted; every profile flag and the
			adapterCommand: wrapper,
		});

		expect(gated.sandboxed).toBe(true);
		expect(gated.args).toContain("-p");

		const handle = await startWorker({
			peer: peer({ sandbox: true }),
			layout,
			cwd,
			// No plan is handed in: the launcher gates the opted-in peer itself.
			sandboxAdapter: {
				platform: "darwin",
				which: async () => "/usr/bin/sandbox-exec",
				probeBridge: async () => true,
				adapterCommand: wrapper,
			},
		});
		cleanups.push(() => handle.stop());

		expect(handle.state).toBe("running");
		// The profile was consumed and the real CLI invocation reached the
		// wrapper as its payload.
		const recorded = await readFile(marker, "utf8");
		// The `-p <profile>` pair was consumed by the adapter, not forwarded.
		expect(recorded.split(" ")).not.toContain("-p");
		expect(recorded).not.toContain("deny network");
		expect(recorded.startsWith("bun ")).toBe(true);
		expect(recorded).toContain("cli.js");
		expect(recorded).toContain("--mode");
	});

	test("stopping a sandboxed worker terminates the sandboxed child", async () => {
		const { cwd, layout } = await workerFixture({}, [{ text: "ok" }]);

		// Records the grandchild pid so the test can check it really died: the
		// parent kills the shim, and an unforwarded signal would orphan it.
		const pidFile = join(layout.root, "child-pid");
		const wrapper = join(layout.root, "fake-sandbox");
		await writeFile(
			wrapper,
			[
				"#!/bin/sh",
				'if [ "$1" = "-p" ]; then shift 2; fi',
				"# exec keeps the RPC stdin pipe attached; $$ is the pid the payload",
				"# inherits, so recording it identifies the sandboxed child.",
				`printf '%s' "$$" > ${JSON.stringify(pidFile)}`,
				'exec "$@"',
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);

		const handle = await startWorker({
			peer: peer({ sandbox: true }),
			layout,
			cwd,
			sandboxAdapter: {
				platform: "darwin",
				which: async () => "/usr/bin/sandbox-exec",
				probeBridge: async () => true,
				adapterCommand: wrapper,
			},
		});
		const childPid = Number(await readFile(pidFile, "utf8"));
		expect(childPid).toBeGreaterThan(0);

		await handle.stop();

		// `kill -0` throws once the process is gone.
		let alive = true;
		try {
			process.kill(childPid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});

	test("a peer with sandbox: true is gated without a caller-supplied plan", async () => {
		const { cwd, layout } = await workerFixture({}, [{ text: "ok" }]);
		const wrapper = await passthroughAdapter(layout.root);

		const probed: string[] = [];
		const handle = await startWorker({
			peer: peer({ sandbox: true }),
			layout,
			cwd,
			// §7:141 — layer 1 is opt-in, but once opted in the launcher must
			// gate it itself rather than trusting a caller to pass a plan.
			sandboxAdapter: {
				platform: "darwin",
				which: async (binary) => {
					probed.push(binary);
					return `/usr/bin/${binary}`;
				},
				probeBridge: async () => true,
				adapterCommand: wrapper,
			},
		});
		cleanups.push(() => handle.stop());

		expect(probed).toEqual(["sandbox-exec"]);
		expect(handle.sandboxed).toBe(true);
		expect(await Bun.file(join(layout.root, "sandbox-shim.ts")).exists()).toBe(
			true,
		);
	});

	test("sandbox: true with a missing adapter refuses to start", async () => {
		const { cwd, layout } = await workerFixture({}, [{ text: "ok" }]);

		// Fail closed: never silently downgrade an opted-in agent.
		await expect(
			startWorker({
				peer: peer({ sandbox: true }),
				layout,
				cwd,
				sandboxAdapter: {
					platform: "darwin",
					which: async () => null,
					probeBridge: async () => true,
				},
			}),
		).rejects.toThrow(/sandbox-exec/);
	});

	test("an omitted sandbox key stays unsandboxed per §7 defaults", async () => {
		const handle = await start();

		expect(handle.sandboxed).toBe(false);
		expect(
			await Bun.file(join(handle.layout.root, "sandbox-shim.ts")).exists(),
		).toBe(false);
	});

	test("sandbox: false stays unsandboxed even when an adapter exists", async () => {
		const { cwd, layout } = await workerFixture({}, [{ text: "ok" }]);

		const handle = await startWorker({
			peer: peer({ sandbox: false }),
			layout,
			cwd,
			sandboxAdapter: {
				platform: "darwin",
				which: async () => "/usr/bin/sandbox-exec",
				probeBridge: async () => true,
			},
		});
		cleanups.push(() => handle.stop());

		expect(handle.sandboxed).toBe(false);
	});
});

describe("classifyAgentSpawn — subtask vs durable peer", () => {
	test("a one-shot subtask payload is rejected as a peer spawn", () => {
		expect(
			classifyAgentSpawn({
				name: "helper",
				prompt: "Refactor this module.",
				expected_output: "A summary of the changes.",
			}),
		).toBe("subtask");
	});

	test("a durable teammate payload is accepted", () => {
		expect(
			classifyAgentSpawn({
				name: "researcher",
				prompt: "Track upstream releases.",
				rooms: ["#releases"],
			}),
		).toBe("peer");
	});

	test("expected_output plus rooms is still a peer", () => {
		expect(
			classifyAgentSpawn({
				name: "researcher",
				prompt: "Track upstream releases.",
				rooms: ["#releases"],
				expected_output: "Weekly digest.",
			}),
		).toBe("peer");
	});

	test("neither rooms nor expected_output is a subtask", () => {
		expect(classifyAgentSpawn({ name: "helper", prompt: "Do a thing." })).toBe(
			"subtask",
		);
	});

	test("an empty rooms list does not make a peer", () => {
		expect(
			classifyAgentSpawn({ name: "helper", prompt: "Do a thing.", rooms: [] }),
		).toBe("subtask");
	});
});
