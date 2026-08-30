import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { materializeWorker } from "../src/daemon/materializer";
import { createPeerStore, type PeerStore } from "../src/daemon/peer-store";
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
import { resolveOmpCli } from "../src/worker/lifecycle";
import toolbeltExtension from "../src/worker/toolbelt";
import {
	operatorIdentities,
	TEST_OPERATOR_TOKEN,
} from "./fixtures/control-client";

const cleanups: Array<() => Promise<void>> = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSocketPath = process.env.OH_MY_AGENT_SOCKET;
const originalControlToken = process.env.OH_MY_AGENT_CONTROL_TOKEN;

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
	if (originalControlToken === undefined)
		delete process.env.OH_MY_AGENT_CONTROL_TOKEN;
	else process.env.OH_MY_AGENT_CONTROL_TOKEN = originalControlToken;
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(): Promise<{
	tools: Map<string, ToolDefinition>;
	rooms: RoomStore;
	supervisor: Supervisor;
	spawnCalls: string[];
	workerPrompts: string[];
	socketPath: string;
	store: PeerStore;
	projectAgentRoot: string;
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
	const rooms = await RoomStore.open(join(rootDir, "rooms.sqlite"));
	const projectAgentRoot = join(rootDir, "project-agents");
	const store = createPeerStore({
		user: join(rootDir, "user-agents"),
		project: projectAgentRoot,
	});
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
		spawnPeer: async (name, options): Promise<AgentSpawnResult> => {
			spawnCalls.push(name);
			peers.set(name, {
				worker: { ...worker, name },
				accountId: "test",
				rooms: [],
				...(options?.parent === undefined ? {} : { parent: options.parent }),
			});
			return { name, state: "running" };
		},
		store,
		writeDefinition: async (fields, options) =>
			await store.write(fields, options),
		armSchedule: () => undefined,
		bumpAccount: async () => [],
	};
	const socket = await startControlSocket({
		socketPath,
		context,
		identities: operatorIdentities(),
	});
	cleanups.push(async () => {
		await socket.close();
		rooms.close();
		await rm(rootDir, { recursive: true, force: true });
	});

	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.OH_MY_AGENT_SOCKET;
	process.env.OH_MY_AGENT_CONTROL_TOKEN = TEST_OPERATOR_TOKEN;
	const tools = new Map<string, ToolDefinition>();
	toolbeltExtension({
		zod,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI);
	return {
		tools,
		rooms,
		store,
		supervisor,
		projectAgentRoot,
		spawnCalls,
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
	test("registers nine additive tools and pins their selection guidance", async () => {
		const { tools } = await harness();
		expect([...tools.keys()]).toEqual([
			"chat_send",
			"chat_read",
			"chat_wait",
			"chat_react",
			"chat_unreact",
			"agent_create",
			"agent_spawn",
			"agent_status",
			"task_handoff",
		]);
		const guidance =
			"native task for temporary in-run subagents; agent_create then agent_spawn with parent for persistent children; agent_spawn without parent for top-level peers; post to a room to talk to an existing peer";
		expect(tools.get("agent_create")?.description).toContain(guidance);
		expect(tools.get("agent_spawn")?.description).toContain(guidance);
		expect(tools.get("agent_spawn")?.description).toContain(
			"Parentage is cooperative metadata, never an authority boundary.",
		);
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
		const cliPath = resolveOmpCli();
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
		const { tools, spawnCalls, workerPrompts } = await harness();

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
	});

	test("creates then spawns a persistent child through the production socket", async () => {
		const { tools } = await harness();
		const created = await invoke(tools, "agent_create", {
			name: "qa",
			description: "Checks the work.",
			model: ["anthropic/claude-sonnet-4-5"],
			spawns: ["scout"],
			rooms: ["#qa"],
			body: "You are qa.",
		});
		expect(created.details).toEqual({ name: "qa", created: true });

		const spawned = await invoke(tools, "agent_spawn", {
			name: "qa",
			parent: true,
		});
		expect(spawned.details).toEqual({ name: "qa", state: "running" });
		const status = await invoke(tools, "agent_status", { name: "qa" });
		expect(status.details).toMatchObject({
			agents: [{ name: "qa", parent: "reviewer" }],
		});
	});

	test("refuses one-shot markers even when child parentage is requested", async () => {
		const { tools, spawnCalls } = await harness();
		const result = await invoke(tools, "agent_spawn", {
			name: "one-shot-child",
			parent: true,
			expected_output: "a patch",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("native task");
		expect(spawnCalls).toEqual([]);
	});
	test("surfaces parser refusal verbatim and leaves no definition", async () => {
		const { tools, store, projectAgentRoot } = await harness();
		const result = await invoke(tools, "agent_create", {
			name: "broken",
			description: "Has no spawn policy.",
			body: "You are broken.",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Missing required field: spawns");
		expect(await store.get("broken")).toBeUndefined();
		expect(await Bun.file(join(projectAgentRoot, "broken.md")).exists()).toBe(
			false,
		);
	});

	test("chat_wait blocks until the daemon returns a new message", async () => {
		const { tools } = await harness();
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
	});

	test("a reaction is visible to readers and duplicate adds stay singular", async () => {
		const { tools } = await harness();
		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "Take this task",
		});
		const id = messageId(sent);

		const first = await invoke(tools, "chat_react", {
			messageId: id,
			emoji: "👀",
		});
		expect(first.details).toMatchObject({ messageId: id, reacted: true });
		const duplicate = await invoke(tools, "chat_react", {
			messageId: id,
			emoji: "👀",
		});
		expect(duplicate.details).toMatchObject({ messageId: id, reacted: true });

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

	test("rejects invalid reaction message IDs before a valid production call", async () => {
		const { tools } = await harness();
		for (const messageId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const result = await invoke(tools, "chat_react", {
				messageId,
				emoji: "👀",
			});
			expect(result.isError).toBe(true);
		}

		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "React to this",
		});
		const id = messageId(sent);
		const valid = await invoke(tools, "chat_react", {
			messageId: id,
			emoji: "👀",
		});
		expect(valid.isError).toBeUndefined();
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
		process.env.OH_MY_AGENT_CONTROL_TOKEN = TEST_OPERATOR_TOKEN;
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

	test("rejects unknown reactions locally while valid reactions reach production", async () => {
		const { tools } = await harness();
		const sent = await invoke(tools, "chat_send", {
			room: "#general",
			author: "coordinator",
			body: "Status this",
		});
		const id = messageId(sent);

		const result = await invoke(tools, "chat_react", {
			messageId: id,
			emoji: "🎉",
		});
		expect(result.isError).toBe(true);
		for (const allowed of ["👀", "⏳", "✅", "❌"]) {
			expect(text(result)).toContain(allowed);
		}

		const valid = await invoke(tools, "chat_react", {
			messageId: id,
			emoji: "✅",
		});
		expect(valid.isError).toBeUndefined();
		const read = await invoke(tools, "chat_read", { room: "#general" });
		expect(read.details).toMatchObject({
			messages: [{ id, reactions: [{ actor: "reviewer", emoji: "✅" }] }],
		});
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
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
					},
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
		process.env.OH_MY_AGENT_CONTROL_TOKEN = TEST_OPERATOR_TOKEN;

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
