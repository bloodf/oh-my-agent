import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
	rooms: RoomStore;
	supervisor: Supervisor;
	spawnCalls: string[];
	transportMethods: string[];
	workerPrompts: string[];
	socketPath: string;
}> {
	const rootDir = await mkdtemp(join(tmpdir(), "oma-toolbelt-"));
	const agentDir = join(
		rootDir,
		"workers",
		"reviewer",
		"home",
		".omp",
		"agent",
	);
	await mkdir(agentDir, { recursive: true });
	const socketPath = join(rootDir, "daemon.sock");
	const productionSocketPath = join(rootDir, "production.sock");
	const rooms = await RoomStore.open(join(rootDir, "rooms.sqlite"));
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
			const frame = JSON.parse(body) as {
				id?: unknown;
				method?: unknown;
				params?: Record<string, unknown>;
			};
			const method = String(frame.method);
			transportMethods.push(method);
			if (method === "chat_react" || method === "chat_unreact") {
				const messageId = Number(frame.params?.messageId);
				const emoji = String(frame.params?.emoji);
				const actor = frame.params?.actor;
				if (typeof actor !== "string" || actor.length === 0) {
					throw new Error("reaction actor is required");
				}
				if (method === "chat_react") await rooms.react(messageId, actor, emoji);
				else await rooms.unreact(messageId, actor, emoji);
				return Response.json({
					jsonrpc: "2.0",
					id: frame.id,
					result: { messageId, emoji, reacted: method === "chat_react" },
				});
			}

			const response = await fetch("http://localhost/rpc", {
				unix: productionSocketPath,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			if (method !== "chat_read" || !response.ok) return response;

			// Production protocol intentionally lacks reactions. Enrich only this
			// test observer after forwarding the unchanged read request.
			const payload = (await response.json()) as {
				result?: { messages?: Array<Record<string, unknown> & { id: number }> };
			};
			const stored = await rooms.listMessages(String(frame.params?.room), {
				afterId: frame.params?.sinceId as number | undefined,
				limit: frame.params?.limit as number | undefined,
			});
			const reactions = new Map(
				stored.map((message) => [message.id, message.reactions]),
			);
			if (payload.result?.messages) {
				payload.result.messages = payload.result.messages.map((message) => ({
					...message,
					reactions: reactions.get(message.id) ?? [],
				}));
			}
			return Response.json(payload);
		},
	} as unknown as Bun.Serve.Options<undefined>);
	cleanups.push(async () => {
		proxy.stop(true);
		await socket.close();
		rooms.close();
		await rm(rootDir, { recursive: true, force: true });
	});

	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.OH_MY_AGENT_SOCKET;
	const tools = new Map<string, ToolDefinition>();
	toolbeltExtension({
		zod,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI);
	return {
		tools,
		rooms,
		supervisor,
		spawnCalls,
		transportMethods,
		workerPrompts,
		socketPath,
	};
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

function messageId(result: ToolResult): number {
	const details = result.details;
	if (
		typeof details !== "object" ||
		details === null ||
		!("messageId" in details) ||
		typeof details.messageId !== "number"
	) {
		throw new Error("Expected numeric messageId");
	}
	return details.messageId;
}

describe("worker toolbelt", () => {
	test("registers eight additive tools and states their conventions", async () => {
		const { tools } = await harness();
		expect([...tools.keys()]).toEqual([
			"chat_send",
			"chat_read",
			"chat_wait",
			"chat_react",
			"chat_unreact",
			"agent_spawn",
			"agent_status",
			"task_handoff",
		]);
		expect(tools.get("agent_spawn")?.description).toContain("durable peer");
		expect(tools.get("agent_spawn")?.description).toContain("native task");
		const reactionDescription = tools.get("chat_react")?.description ?? "";
		for (const convention of ["👀", "⏳", "✅", "❌"]) {
			expect(reactionDescription).toContain(convention);
		}
		expect(reactionDescription).toContain("reading/picked-up");
		expect(reactionDescription).toContain("in-progress");
		expect(reactionDescription).toContain("done");
		expect(reactionDescription).toContain("blocked/failed");
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

	test("a reaction is visible to readers and duplicate adds stay singular", async () => {
		const { tools } = await harness();
		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "Take this task",
		});
		const id = messageId(sent);

		await invoke(tools, "chat_react", { messageId: id, emoji: "👀" });
		await invoke(tools, "chat_react", { messageId: id, emoji: "👀" });

		for (let reader = 0; reader < 2; reader++) {
			const read = await invoke(tools, "chat_read", { room: "#general" });
			expect(read.details).toMatchObject({
				messages: [
					{
						id,
						reactions: [{ actor: "reviewer", emoji: "👀" }],
					},
				],
			});
		}
	});

	test("rejects invalid reaction message IDs before transport", async () => {
		const { tools, transportMethods } = await harness();
		for (const messageId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const result = await invoke(tools, "chat_react", {
				messageId,
				emoji: "👀",
			});
			expect(result.isError).toBe(true);
			expect(transportMethods).toEqual([]);
		}

		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "React to this",
		});
		const id = messageId(sent);
		transportMethods.length = 0;

		await invoke(tools, "chat_react", { messageId: id, emoji: "👀" });
		expect(transportMethods).toEqual(["chat_react"]);
	});

	test("rejects an unknown reaction emoji returned by the daemon", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "oma-reaction-result-"));
		const socketPath = join(rootDir, "daemon.sock");
		const agentDir = join(
			rootDir,
			"workers",
			"reviewer",
			"home",
			".omp",
			"agent",
		);
		await mkdir(agentDir, { recursive: true });
		const daemon = Bun.serve({
			unix: socketPath,
			fetch: async (request: Request) => {
				const frame = (await request.json()) as { id: unknown };
				return Response.json({
					jsonrpc: "2.0",
					id: frame.id,
					result: { messageId: 1, emoji: "🎉", reacted: true },
				});
			},
		} as unknown as Bun.Serve.Options<undefined>);
		cleanups.push(async () => {
			daemon.stop(true);
			await rm(rootDir, { recursive: true, force: true });
		});
		process.env.OH_MY_AGENT_SOCKET = socketPath;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const tools = new Map<string, ToolDefinition>();
		toolbeltExtension({
			zod,
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI);

		const result = await invoke(tools, "chat_react", {
			messageId: 1,
			emoji: "👀",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("emoji");
	});

	test("rejects unknown reactions locally with a non-vacuous transport guard", async () => {
		const { tools, transportMethods, socketPath } = await harness();
		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "Status this",
		});
		const id = messageId(sent);
		transportMethods.length = 0;

		// Negative control: the seam accepts any non-empty store reaction, so this
		// invalid status reaches transport if the toolbelt omits its closed-set guard.
		await fetch("http://localhost/rpc", {
			unix: socketPath,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: "negative-control",
				method: "chat_react",
				params: { messageId: id, actor: "reviewer", emoji: "🎉" },
			}),
		});
		expect(transportMethods).toEqual(["chat_react"]);
		transportMethods.length = 0;

		const result = await invoke(tools, "chat_react", {
			messageId: id,
			emoji: "🎉",
		});
		expect(result.isError).toBe(true);
		for (const allowed of ["👀", "⏳", "✅", "❌"]) {
			expect(text(result)).toContain(allowed);
		}
		expect(transportMethods).toEqual([]);
	});

	test("a reaction neither marks unread nor changes wake delivery", async () => {
		const { tools, rooms, supervisor, workerPrompts } = await harness();
		const message = await rooms.post({
			room: "#general",
			author: "coordinator",
			body: "Still wake reviewer",
		});
		expect(await rooms.unreadCount("reviewer", "#general")).toBe(1);

		await invoke(tools, "chat_react", { messageId: message.id, emoji: "⏳" });
		expect(await rooms.unreadCount("reviewer", "#general")).toBe(1);
		expect(workerPrompts).toEqual([]);

		expect(await supervisor.deliver("reviewer")).toBe(true);
		expect(workerPrompts).toEqual([
			"[#general] coordinator: Still wake reviewer",
		]);
		expect(await rooms.unreadCount("reviewer", "#general")).toBe(0);
	});

	test("chat_unreact removes a reaction and repeated removal is a no-op", async () => {
		const { tools } = await harness();
		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "Clear status",
		});
		const id = messageId(sent);
		await invoke(tools, "chat_react", { messageId: id, emoji: "✅" });

		for (let removal = 0; removal < 2; removal++) {
			const result = await invoke(tools, "chat_unreact", {
				messageId: id,
				emoji: "✅",
			});
			expect(result.isError).toBeUndefined();
		}
		const read = await invoke(tools, "chat_read", { room: "#general" });
		expect(read.details).toMatchObject({
			messages: [{ id, reactions: [] }],
		});
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
		const rootDir = await mkdtemp(join(tmpdir(), "oma-toolbelt-invalid-"));
		const agentDir = join(rootDir, "workers", "reviewer");
		await mkdir(agentDir, { recursive: true });
		const socketPath = join(rootDir, "daemon.sock");
		const server = Bun.serve({
			unix: socketPath,
			fetch: () =>
				Response.json({ jsonrpc: "2.0", id: 1, result: { messageId: "bad" } }),
		});
		cleanups.push(async () => {
			server.stop(true);
			await rm(rootDir, { recursive: true, force: true });
		});
		process.env.OH_MY_AGENT_SOCKET = socketPath;
		process.env.PI_CODING_AGENT_DIR = agentDir;

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
