import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import { createPeerStore } from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import {
	type ControlIdentity,
	type DaemonContext,
	type PeerRecord,
	startControlSocket,
} from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import { createDaemonClient } from "../src/extension/widget";
import { RoomStore } from "../src/rooms/store";
import { fingerprintPeerDefinition } from "../src/shared/agent-definition";
import {
	ERROR_CODE,
	type JsonRpcFailure,
	type JsonRpcSuccess,
	type MethodName,
} from "../src/shared/protocol";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function rpc(
	socketPath: string,
	method: string,
	params: unknown,
	token?: string,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
	const response = await fetch("http://localhost/rpc", {
		unix: socketPath,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
	});
	return (await response.json()) as JsonRpcSuccess | JsonRpcFailure;
}

function failure(frame: JsonRpcSuccess | JsonRpcFailure): JsonRpcFailure {
	if (!("error" in frame))
		throw new Error(`Expected failure: ${JSON.stringify(frame)}`);
	return frame;
}

async function socketHarness(): Promise<{
	socketPath: string;
	rooms: RoomStore;
	identities: Map<string, ControlIdentity>;
	spawnCalls: Array<{ name: string; parent?: string }>;
	kills: string[];
	/** What each peer's worker was prompted with, in order. */
	prompts: Map<string, string[]>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "oma-identity-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(async () => rooms.close());
	await rooms.createRoom({ id: "#general", kind: "channel" });

	// Prompts are the observable end of a delivery: an authorization that
	// leaked would show up here even when the wire frame looks innocent.
	const prompts = new Map<string, string[]>();
	const worker = (name: string): SupervisedWorker => {
		const received: string[] = [];
		prompts.set(name, received);
		return {
			name,
			state: "running",
			prompt: async (message) => {
				received.push(message);
			},
			park: async () => {},
			resume: async () => {},
			stop: async () => {},
		};
	};
	const supervisor = new Supervisor({
		rooms,
		scheduler: new Scheduler(),
		now: Date.now,
	});
	const reviewer = worker("reviewer");
	const other = worker("other");
	await supervisor.register({
		worker: reviewer,
		accountId: "test",
		mode: "subscription",
		rooms: ["#general"],
	});
	// Shares #general with reviewer, so a handoff between them has a room both
	// peers read — the case ADR-014's worker binding has to keep working.
	await supervisor.register({
		worker: other,
		accountId: "test",
		mode: "subscription",
		rooms: ["#general"],
	});
	const peers = new Map<string, PeerRecord>([
		["reviewer", { worker: reviewer, accountId: "test", rooms: ["#general"] }],
		["other", { worker: other, accountId: "test", rooms: ["#general"] }],
	]);
	const knownRooms = new Map([
		[
			"#general",
			{ id: "#general", kind: "channel" as const, name: "#general" },
		],
	]);
	const spawnCalls: Array<{ name: string; parent?: string }> = [];
	const kills: string[] = [];
	const schedules = new Map([
		[
			"reviewer:schedule:0",
			{
				id: "reviewer:schedule:0",
				peer: "reviewer",
				cron: "0 * * * *",
				action: "review",
				enabled: true,
				nextFireAt: Date.now() + 60_000,
			},
		],
	]);
	const store = createPeerStore({
		user: join(dir, "definitions-user"),
		project: join(dir, "definitions-project"),
	});
	const context: DaemonContext = {
		rooms,
		supervisor,
		peers,
		knownRooms,
		schedules,
		startedAt: Date.now(),
		now: Date.now,
		ensureRoom: async (id) => {
			if (knownRooms.has(id)) return;
			await rooms.createRoom({
				id,
				kind: id.startsWith("@") ? "dm" : "channel",
			});
		},
		store,
		writeDefinition: async (fields, options) =>
			await store.write(fields, options),
		spawnPeer: async (name, options) => {
			spawnCalls.push({
				name,
				...(options?.parent === undefined ? {} : { parent: options.parent }),
			});
			return { name, state: "running" };
		},
		killPeer: async (name) => {
			kills.push(name);
		},
		armSchedule: (id, enabled) => {
			const schedule = schedules.get(id);
			if (schedule === undefined) return undefined;
			schedule.enabled = enabled;
			return schedule;
		},
		bumpAccount: async () => ["reviewer"],
	};
	const identities = new Map<string, ControlIdentity>([
		["operator-token", { kind: "operator" }],
		["worker-token", { kind: "worker", peerName: "reviewer" }],
	]);
	const socketPath = join(dir, "daemon.sock");
	const socket = await startControlSocket({ socketPath, context, identities });
	cleanups.push(() => socket.close());
	return { socketPath, rooms, identities, spawnCalls, kills, prompts };
}

async function writePeer(
	agentDir: string,
	wake?: { rooms: boolean },
): Promise<void> {
	const root = join(agentDir, "oh-my-agent", "agents");
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "reviewer.md"),
		`---\nname: "reviewer"\ndescription: "Reviews."\nmodel: "openai/gpt-4.1"\nspawns: "*"\nrooms: ["#general"]${wake === undefined ? "" : `\nwake: ${JSON.stringify(wake)}`}\n---\nReview.\n`,
		"utf8",
	);
}

describe("control-socket identity", () => {
	test("refuses an unauthenticated call with the declared error shape", async () => {
		const { socketPath } = await socketHarness();
		expect(
			failure(await rpc(socketPath, "chat_read", { room: "#general" })).error,
		).toEqual({
			code: ERROR_CODE.UNAUTHORIZED,
			message: "Unauthorized",
			data: { protocolVersion: 1 },
		});
	});

	test("lets a worker read chat but refuses operator-only kill", async () => {
		const { socketPath, kills } = await socketHarness();
		expect(
			await rpc(socketPath, "chat_read", { room: "#general" }, "worker-token"),
		).toMatchObject({ result: { messages: [] } });
		expect(
			failure(await rpc(socketPath, "kill", { name: "other" }, "worker-token"))
				.error,
		).toMatchObject({ code: ERROR_CODE.FORBIDDEN });
		expect(kills).toEqual([]);
	});

	test("validates worker params before refusing method scope", async () => {
		const { socketPath } = await socketHarness();
		const invalid = failure(await rpc(socketPath, "kill", {}, "worker-token"));
		expect(invalid.error).toMatchObject({
			code: ERROR_CODE.INVALID_PARAMS,
			data: { field: "name", protocolVersion: 1 },
		});
	});

	test("requires a worker spawn parent to equal its identity", async () => {
		const { socketPath, spawnCalls } = await socketHarness();
		expect(
			failure(
				await rpc(
					socketPath,
					"agent_spawn",
					{ name: "child", parent: "other" },
					"worker-token",
				),
			).error.code,
		).toBe(ERROR_CODE.FORBIDDEN);
		expect(
			failure(
				await rpc(socketPath, "agent_spawn", { name: "child" }, "worker-token"),
			).error.code,
		).toBe(ERROR_CODE.FORBIDDEN);
		expect(
			await rpc(
				socketPath,
				"agent_spawn",
				{ name: "child", parent: "reviewer" },
				"worker-token",
			),
		).toMatchObject({ result: { name: "child", state: "running" } });
		expect(spawnCalls).toEqual([{ name: "child", parent: "reviewer" }]);
	});

	test("lets the operator call every operator-only method family", async () => {
		const { socketPath, kills } = await socketHarness();
		const calls: Array<[MethodName, unknown]> = [
			["inject", { name: "reviewer", message: "continue" }],
			["bump", { account: "test", budgetUsd: 20 }],
			["rooms_list", {}],
			["rooms_post", { room: "#general", body: "operator post" }],
			["schedules_list", {}],
			["schedules_arm", { scheduleId: "reviewer:schedule:0", enabled: false }],
			[
				"agent_create",
				{
					name: "created",
					description: "Created peer.",
					model: ["openai/gpt-4.1"],
					spawns: "*",
					body: "Work.",
				},
			],
			["definition_get", { name: "created" }],
			[
				"definition_update",
				{ name: "created", changes: { description: "Updated peer." } },
			],
			["kill", { name: "other" }],
		];
		for (const [method, params] of calls) {
			const frame = await rpc(socketPath, method, params, "operator-token");
			if ("error" in frame) {
				throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`);
			}
		}
		expect(kills).toEqual(["other"]);
	});

	test("revokes a worker token when respawn installs its replacement", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "oma-respawn-identity-"));
		cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
		await writePeer(agentDir);
		const tokens: string[] = [];
		const factory: WorkerFactory = async ({ peer, controlToken }) => {
			tokens.push(controlToken);
			return {
				name: peer.name,
				fingerprint: fingerprintPeerDefinition(peer),
				state: "running",
				prompt: async () => {},
				park: async () => {},
				resume: async () => {},
				stop: async () => {},
			} as SupervisedWorker;
		};
		const handle = await bootDaemon({
			env: { OMA_CONSOLE: "0" },
			agentDir,
			projectDir: agentDir,
			workerFactory: factory,
		});
		cleanups.push(() => handle.close());
		const operatorToken = (
			await Bun.file(join(agentDir, "oh-my-agent", "console-token")).text()
		).trim();
		const first = tokens[0];
		expect(first).toBeString();
		expect(
			await rpc(handle.socketPath, "chat_read", { room: "#general" }, first),
		).toHaveProperty("result");

		await writePeer(agentDir, { rooms: false });
		await rpc(
			handle.socketPath,
			"chat_send",
			{ room: "#general", body: "rebuild" },
			operatorToken,
		);
		expect(tokens).toHaveLength(2);
		expect(tokens[1]).not.toBe(first);
		expect(
			failure(
				await rpc(handle.socketPath, "chat_read", { room: "#general" }, first),
			).error.code,
		).toBe(ERROR_CODE.UNAUTHORIZED);
		expect(
			await rpc(
				handle.socketPath,
				"chat_read",
				{ room: "#general" },
				tokens[1],
			),
		).toHaveProperty("result");
	});

	test("widget client reads and presents the operator token", async () => {
		const { socketPath } = await socketHarness();
		await writeFile(
			join(socketPath, "..", "console-token"),
			"operator-token",
			"utf8",
		);
		const client = createDaemonClient(socketPath);
		const result = await client.call<{ agents: unknown[] }>("agent_status", {});
		expect(result.agents).toHaveLength(2);
	});
});

// ── Attribution binding (ADR-014) ────────────────────────────────────────────

describe("control-socket attribution", () => {
	test("a worker posting as another peer is recorded under its own name", async () => {
		const { socketPath, rooms } = await socketHarness();

		const frame = await rpc(
			socketPath,
			"chat_send",
			{ room: "#general", author: "other", body: "Not my words." },
			"worker-token",
		);

		// Overwritten, not refused: a mislabelling worker must not enter an
		// error loop (ADR-014 alternatives).
		expect(frame).toHaveProperty("result");
		expect(await rooms.listMessages("#general", {})).toMatchObject([
			{ author: "reviewer", body: "Not my words." },
		]);
	});

	test("a worker reacting as another peer is recorded under its own name", async () => {
		const { socketPath, rooms } = await socketHarness();
		const posted = await rooms.post({
			room: "#general",
			author: "@you",
			body: "Who picked this up?",
		});

		expect(
			await rpc(
				socketPath,
				"chat_react",
				{ messageId: posted.id, actor: "other", emoji: "👀" },
				"worker-token",
			),
		).toMatchObject({ result: { actor: "reviewer", added: true } });
		expect((await rooms.listMessages("#general", {}))[0]?.reactions).toEqual([
			{ actor: "reviewer", emoji: "👀" },
		]);
	});

	test("a worker unreacting as another peer cannot clear that peer's status", async () => {
		const { socketPath, rooms } = await socketHarness();
		const posted = await rooms.post({
			room: "#general",
			author: "@you",
			body: "Two reactors.",
		});
		await rooms.react(posted.id, "other", "👀");
		await rooms.react(posted.id, "reviewer", "👀");

		expect(
			await rpc(
				socketPath,
				"chat_unreact",
				{ messageId: posted.id, actor: "other", emoji: "👀" },
				"worker-token",
			),
		).toMatchObject({ result: { actor: "reviewer", removed: true } });
		// Only its own reaction went; the other peer's status is untouched.
		expect((await rooms.listMessages("#general", {}))[0]?.reactions).toEqual([
			{ actor: "other", emoji: "👀" },
		]);
	});

	test("the operator token keeps its privileged attribution override", async () => {
		const { socketPath, rooms } = await socketHarness();

		expect(
			await rpc(
				socketPath,
				"chat_send",
				{ room: "#general", author: "other", body: "Speaking for them." },
				"operator-token",
			),
		).toHaveProperty("result");
		expect(await rooms.listMessages("#general", {})).toMatchObject([
			{ author: "other", body: "Speaking for them." },
		]);

		const posted = (await rooms.listMessages("#general", {}))[0];
		expect(posted).toBeDefined();
		expect(
			await rpc(
				socketPath,
				"chat_react",
				{ messageId: posted?.id, actor: "other", emoji: "✅" },
				"operator-token",
			),
		).toMatchObject({ result: { actor: "other" } });
	});

	test("a worker handing off as another peer is recorded under its own name", async () => {
		const { socketPath, rooms } = await socketHarness();

		const frame = await rpc(
			socketPath,
			"task_handoff",
			{
				fromAgent: "other",
				toAgent: "other",
				summary: "finish the audit",
			},
			"worker-token",
		);

		// A handoff names who is handing work over, and a worker that can
		// forge that name can hand its own work off in another peer's voice.
		// Overwritten rather than refused, exactly as chat_send is.
		expect(frame).toHaveProperty("result");
		expect(await rooms.listMessages("#general", {})).toMatchObject([
			{ author: "reviewer", body: expect.stringContaining("from @reviewer") },
		]);
	});
});

// ── Identity negatives (T-1609) ──────────────────────────────────────────────

describe("control-socket worker scope", () => {
	test("a worker cannot inject into a peer it does not own", async () => {
		const { socketPath, prompts } = await socketHarness();

		expect(
			failure(
				await rpc(
					socketPath,
					"inject",
					{ name: "other", message: "do my bidding" },
					"worker-token",
				),
			).error.code,
		).toBe(ERROR_CODE.FORBIDDEN);

		// Refused before the handler, not merely refused in the answer: a
		// forbidden frame over a peer that was already prompted is a leak that
		// the wire assertion alone would not catch.
		expect(prompts.get("other")).toEqual([]);
		expect(prompts.get("reviewer")).toEqual([]);
	});

	test("a worker hands a task off to a peer that shares its room", async () => {
		const { socketPath, prompts } = await socketHarness();

		const frame = await rpc(
			socketPath,
			"task_handoff",
			{
				fromAgent: "reviewer",
				toAgent: "other",
				summary: "finish the audit",
			},
			"worker-token",
		);

		expect(frame).toMatchObject({
			result: { handoffId: expect.stringContaining("#general:") },
		});
		// The handoff posts into the shared room, and the post is what wakes
		// the receiver — a handoff nobody was prompted for is just a message.
		expect(prompts.get("other")?.join("\n")).toContain("finish the audit");
	});
});
