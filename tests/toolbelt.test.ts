import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { materializeWorker } from "../src/daemon/materializer";
import { Scheduler } from "../src/daemon/scheduler";
import {
	type DaemonContext,
	type PeerRecord,
	startControlSocket,
} from "../src/daemon/socket";
import { Supervisor } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";
import { parsePeerDefinition } from "../src/shared/agent-definition";
import type { AgentSpawnResult } from "../src/shared/protocol";
import toolbeltExtension from "../src/worker/toolbelt";

const cleanups: Array<() => Promise<void>> = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSocketPath = process.env.OH_MY_AGENT_SOCKET;

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalSocketPath === undefined) delete process.env.OH_MY_AGENT_SOCKET;
	else process.env.OH_MY_AGENT_SOCKET = originalSocketPath;
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(): Promise<{
	tools: Map<string, ToolDefinition>;
	spawnCalls: string[];
	transportMethods: string[];
	workerPrompts: string[];
	socketPath: string;
}> {
	const agentDir = await mkdtemp(join(tmpdir(), "oma-toolbelt-"));
	const stateDir = join(agentDir, "oh-my-agent");
	const socketPath = join(stateDir, "daemon.sock");
	const productionSocketPath = join(stateDir, "production.sock");
	const rooms = await RoomStore.open(join(stateDir, "rooms.sqlite"));
	await rooms.createRoom({ id: "#general", kind: "channel" });

	const workerPrompts: string[] = [];
	const worker = {
		name: "reviewer",
		state: "running" as const,
		prompt: async (message: string) => {
			workerPrompts.push(message);
		},
		park: async () => {},
		resume: async () => {},
		stop: async () => {},
	};
	const scheduler = new Scheduler();
	const supervisor = new Supervisor({ rooms, scheduler, now: Date.now });
	await supervisor.register({
		worker,
		accountId: "test",
		mode: "subscription",
		rooms: ["#general"],
	});
	const peers = new Map<string, PeerRecord>([
		["reviewer", { worker, accountId: "test", rooms: ["#general"] }],
	]);
	const spawnCalls: string[] = [];
	const context: DaemonContext = {
		rooms,
		supervisor,
		peers,
		knownRooms: new Map([
			[
				"#general",
				{ id: "#general", kind: "channel" as const, name: "#general" },
			],
		]),
		schedules: new Map(),
		startedAt: Date.now(),
		now: Date.now,
		ensureRoom: async (id) => {
			const kind = id.startsWith("@") ? "dm" : "channel";
			await rooms.createRoom({ id, kind });
			context.knownRooms.set(id, { id, kind, name: id });
		},
		spawnPeer: async (name): Promise<AgentSpawnResult> => {
			spawnCalls.push(name);
			return { name, state: "running" };
		},
		armSchedule: () => undefined,
		bumpAccount: async () => [],
	};
	const socket = await startControlSocket({
		socketPath: productionSocketPath,
		context,
	});
	const transportMethods: string[] = [];
	const proxy = Bun.serve({
		unix: socketPath,
		idleTimeout: 0,
		fetch: async (request: Request) => {
			const body = await request.text();
			const frame: unknown = JSON.parse(body);
			if (typeof frame === "object" && frame !== null && "method" in frame) {
				transportMethods.push(String(frame.method));
			}
			return await fetch("http://localhost/rpc", {
				unix: productionSocketPath,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
		},
	} as unknown as Bun.Serve.Options<undefined>);
	cleanups.push(async () => {
		proxy.stop(true);
		await socket.close();
		rooms.close();
		await rm(agentDir, { recursive: true, force: true });
	});

	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.OH_MY_AGENT_SOCKET = socketPath;
	const tools = new Map<string, ToolDefinition>();
	toolbeltExtension({
		zod,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI);
	return { tools, spawnCalls, transportMethods, workerPrompts, socketPath };
}

async function invoke(
	tools: Map<string, ToolDefinition>,
	name: string,
	params: Record<string, unknown>,
): Promise<ToolResult> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	return (await tool.execute(
		"call-1",
		params,
		undefined,
		undefined,
		{} as never,
	)) as ToolResult;
}

function text(result: ToolResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("worker toolbelt", () => {
	test("registers the six additive tools and states the native task contract", async () => {
		const { tools } = await harness();
		expect([...tools.keys()]).toEqual([
			"chat_send",
			"chat_read",
			"chat_wait",
			"agent_spawn",
			"agent_status",
			"task_handoff",
		]);
		expect(tools.get("agent_spawn")?.description).toContain("durable peer");
		expect(tools.get("agent_spawn")?.description).toContain("native task");
	});

	test("a real OMP child keeps native task while loading the toolbelt", async () => {
		const root = await mkdtemp(join(tmpdir(), "oma-toolbelt-child-"));
		const gateway = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("unused", { status: 500 }),
		});
		const peer = parsePeerDefinition(
			join(root, "reviewer.md"),
			`---\nname: reviewer\ndescription: Reviews code.\nmodel: anthropic/claude-sonnet-4-5\nspawns: [scout]\n---\nCoordinate reviews.`,
		);
		const layout = await materializeWorker({
			rootDir: join(root, "worker"),
			parsedPeer: peer,
			discoveredAgentNames: [],
			inferenceGateway: {
				url: `http://${gateway.hostname}:${gateway.port}`,
				token: "test-token",
			},
			sourceSpawnAgents: {
				scout: "---\nname: scout\ndescription: Reads code.\n---\nRead code.",
			},
		});
		const cliPath = fileURLToPath(
			import.meta.resolve("@oh-my-pi/pi-coding-agent/package.json"),
		).replace(/package\.json$/, "dist/cli.js");
		const client = new RpcClient({
			cliPath,
			cwd: root,
			env: layout.env,
			provider: layout.provider,
			model: layout.modelId,
			sessionDir: layout.sessionDir,
			args: [
				"--trusted-extension",
				join(import.meta.dir, "../src/worker/toolbelt.ts"),
			],
		});
		await client.start();
		cleanups.push(async () => {
			await client.stop();
			gateway.stop(true);
			await rm(root, { recursive: true, force: true });
		});
		const names =
			(await client.getState()).dumpTools?.map((tool) => tool.name) ?? [];
		if (!names.includes("task") || !names.includes("agent_spawn")) {
			throw new Error(
				`Unexpected real-child tools: ${JSON.stringify(names)}; stderr: ${client.getStderr()}`,
			);
		}
	});

	test("executes every tool through the production control socket", async () => {
		const { tools, spawnCalls, transportMethods, workerPrompts } =
			await harness();

		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "review this",
		});
		expect(sent.isError).toBeUndefined();
		expect(sent.details).toMatchObject({ messageId: 1 });
		expect(workerPrompts).toEqual(["[#general] coordinator: review this"]);

		const read = await invoke(tools, "chat_read", { room: "#general" });
		expect(read.details).toMatchObject({
			messages: [{ author: "coordinator", body: "review this" }],
		});

		const status = await invoke(tools, "agent_status", { name: "reviewer" });
		expect(status.details).toMatchObject({
			agents: [{ name: "reviewer", state: "running" }],
		});

		const spawned = await invoke(tools, "agent_spawn", {
			name: "durable",
			rooms: ["#general"],
		});
		expect(spawned.details).toEqual({ name: "durable", state: "running" });
		expect(spawnCalls).toEqual(["durable"]);

		const handoff = await invoke(tools, "task_handoff", {
			fromAgent: "coordinator",
			toAgent: "reviewer",
			summary: "Take over review",
		});
		expect(handoff.details).toMatchObject({ handoffId: "#general:2" });
		expect(transportMethods).toEqual([
			"chat_send",
			"chat_read",
			"agent_status",
			"agent_spawn",
			"task_handoff",
		]);
	});

	test("chat_wait blocks until the daemon returns a new message", async () => {
		const { tools, transportMethods } = await harness();
		let settled = false;
		const waiting = invoke(tools, "chat_wait", {
			room: "#general",
			sinceId: 0,
			timeoutMs: 1_000,
		}).then((result) => {
			settled = true;
			return result;
		});
		await Bun.sleep(75);
		expect(settled).toBe(false);
		await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "wake",
		});
		expect((await waiting).details).toMatchObject({
			messages: [{ body: "wake" }],
		});
		expect(transportMethods).toEqual(["chat_wait", "chat_send"]);
	});

	test("refuses one-shot subtasks locally and proves the guard is non-vacuous", async () => {
		const { tools, spawnCalls, socketPath } = await harness();

		// Negative control: bypassing the toolbelt lets the same subtask-looking
		// payload reach production socket dispatch, so the zero-call assertion fails.
		await expect(
			(async () => {
				await fetch("http://localhost/rpc", {
					unix: socketPath,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: "negative-control",
						method: "agent_spawn",
						params: { name: "one-shot", expected_output: "a patch" },
					}),
				});
				expect(spawnCalls).toEqual([]);
			})(),
		).rejects.toThrow();
		expect(spawnCalls).toEqual(["one-shot"]);
		spawnCalls.length = 0;

		const result = await invoke(tools, "agent_spawn", {
			name: "one-shot",
			expected_output: "a patch",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("native task");
		expect(spawnCalls).toEqual([]);

		await invoke(tools, "agent_spawn", {
			name: "durable-proof",
			rooms: ["#general"],
		});
		expect(spawnCalls).toEqual(["durable-proof"]);
	});

	test("derives the daemon socket from a materialized worker agent dir", async () => {
		const { socketPath } = await harness();
		delete process.env.OH_MY_AGENT_SOCKET;
		process.env.PI_CODING_AGENT_DIR = join(
			dirname(socketPath),
			"workers",
			"coordinator",
			"home",
			".omp",
			"agent",
		);
		const tools = new Map<string, ToolDefinition>();
		toolbeltExtension({
			zod,
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI);
		const result = await invoke(tools, "agent_status", {});
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ agents: [{ name: "reviewer" }] });
	});

	test("rejects daemon results that violate the METHODS contract", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "oma-toolbelt-invalid-"));
		const socketPath = join(agentDir, "daemon.sock");
		const server = Bun.serve({
			unix: socketPath,
			fetch: () =>
				Response.json({ jsonrpc: "2.0", id: 1, result: { messageId: "bad" } }),
		});
		cleanups.push(async () => {
			server.stop(true);
			await rm(agentDir, { recursive: true, force: true });
		});
		process.env.OH_MY_AGENT_SOCKET = socketPath;

		const tools = new Map<string, ToolDefinition>();
		toolbeltExtension({
			zod,
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI);
		const result = await invoke(tools, "chat_send", {
			room: "#general",
			body: "invalid result",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("chat_send result violates protocol");
	});

	test("surfaces daemon protocol errors without stack dumps", async () => {
		const { tools } = await harness();
		const result = await invoke(tools, "agent_status", { name: "missing" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Unknown agent: missing");
		expect(text(result)).not.toContain("Error:");
		expect(text(result)).not.toContain(" at ");
	});

	test("surfaces an unavailable daemon as a concise tool error", async () => {
		const { socketPath } = await harness();
		process.env.OH_MY_AGENT_SOCKET = join(socketPath, "missing");
		const freshTools = new Map<string, ToolDefinition>();
		toolbeltExtension({
			zod,
			registerTool: (tool: ToolDefinition) => freshTools.set(tool.name, tool),
		} as unknown as ExtensionAPI);
		const result = await invoke(freshTools, "chat_read", { room: "#general" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("oh-my-agent daemon unavailable");
		expect(text(result)).not.toContain(" at ");
	});
});
