/**
 * RED tests for T-802: the daemon's agent hierarchy.
 *
 * Public API under test: `bootDaemon(options) -> DaemonHandle` and the control
 * socket's hierarchy surface — `agent_spawn` with a `parent`, `kill` with
 * `keep_children`, `agent_create`/`definition_get`/`definition_update`, and the
 * `parent`/`children` fields on `status` and `agent_status`.
 *
 * What only exists here: parentage is daemon spawn-time state (ADR-011), so
 * every property below is about the daemon's own bookkeeping rather than about
 * a definition on disk. A child records its parent and keeps it across a
 * restart; a spawn that would close a loop is refused with the loop named; a
 * killed parent takes its subtree with it unless the caller explicitly keeps
 * the children, in which case they are reparented to root; and an agent whose
 * parent is gone at boot is refused rather than resumed into an impossible
 * state.
 *
 * Inheritance is deliberately narrow, and the negative half is the point: a
 * child takes its parent's account and the auto-created `#<parent>-team`
 * channel, and specifically does not take the parent's rooms.
 *
 * Nothing here sleeps on a guessed duration. `chat_send` posts through the
 * supervisor, which awaits delivery before answering, so the wire response is
 * itself the signal that every woken peer has been prompted.
 *
 * Every boot runs against a temp agent dir with `env: {}`, so broker discovery
 * finds nothing and embeds a broker over that temp dir — the real user profile
 * and the real vault are never touched.
 *
 * Every success response is validated through the production `METHODS`
 * contract rather than cast into shape, so a server that answers a
 * plausible-looking but non-conforming frame fails here.
 *
 * Workers are stubs following `SupervisedWorker`, as in tests/daemon-main.test.ts:
 * this suite is about daemon bookkeeping, not about the RPC child.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonDb } from "../src/daemon/db";
import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { fingerprintPeerDefinition } from "../src/shared/agent-definition";
import type {
	AgentCreateResult,
	AgentSpawnResult,
	AgentStatus,
	AgentStatusResult,
	DefinitionGetResult,
	DefinitionUpdateResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	KillResult,
	MethodName,
	RoomsListResult,
	StatusResult,
} from "../src/shared/protocol";
import { METHODS } from "../src/shared/protocol-schemas";
import { controlCall, operatorToken } from "./fixtures/control-client";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-tree-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** The task agent every peer's `spawns:` closure names. */
async function writeTaskAgent(agentDir: string): Promise<void> {
	const taskAgents = join(agentDir, "agents");
	await mkdir(taskAgents, { recursive: true });
	await writeFile(
		join(taskAgents, "scout.md"),
		'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
		"utf8",
	);
}

/**
 * Write a peer definition into the agent dir's private user store. `rooms` is
 * passed explicitly by every caller here, because what a child does and does
 * not inherit from its parent's rooms is exactly what several of these tests
 * are about.
 */
async function writePeer(
	agentDir: string,
	name: string,
	frontmatter: Record<string, unknown> = {},
): Promise<void> {
	await writeTaskAgent(agentDir);
	const root = join(agentDir, "oh-my-agent", "agents");
	await mkdir(root, { recursive: true });
	const yaml = Object.entries({
		name,
		description: `${name} peer.`,
		model: "anthropic/claude-sonnet-4-5",
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

/** One materialized worker, as the daemon asked for it. */
interface Build {
	name: string;
	stopped: boolean;
	prompts: string[];
}

/**
 * Workers that fingerprint each build from the definition they were handed, so
 * the supervisor's T-505 staleness check has something real to compare and a
 * rebuild is observable as a second entry in `builds`.
 */
function stubWorkerFactory(): { factory: WorkerFactory; builds: Build[] } {
	const builds: Build[] = [];

	const factory: WorkerFactory = async ({ peer }) => {
		const build: Build = { name: peer.name, stopped: false, prompts: [] };
		builds.push(build);
		return {
			name: peer.name,
			fingerprint: fingerprintPeerDefinition(peer),
			get state() {
				return build.stopped ? "stopped" : "running";
			},
			prompt: async (message: string) => {
				build.prompts.push(message);
			},
			park: async () => {},
			resume: async () => {},
			stop: async () => {
				build.stopped = true;
			},
		} as SupervisedWorker;
	};

	return { factory, builds };
}

async function boot(options: {
	agentDir: string;
	projectDir: string;
}): Promise<{ handle: DaemonHandle; builds: Build[] }> {
	const stub = stubWorkerFactory();
	const handle = await bootDaemon({
		env: {},
		agentDir: options.agentDir,
		projectDir: options.projectDir,
		workerFactory: stub.factory,
	});
	cleanups.push(() => handle.close());
	return { handle, builds: stub.builds };
}

/** One authenticated JSON-RPC round trip over the daemon's unix socket. */
async function rpc(
	socketPath: string,
	method: string,
	params: unknown = {},
): Promise<JsonRpcSuccess | JsonRpcFailure> {
	const token = await operatorToken(dirname(socketPath));
	return (await controlCall(socketPath, method, params, token, 1)) as
		| JsonRpcSuccess
		| JsonRpcFailure;
}

/**
 * Call a method and validate its result through the shared contract before
 * handing it back typed, so a result that drifts from `METHODS` fails at the
 * call site rather than being cast into a shape it does not have.
 */
async function call<T>(
	socketPath: string,
	method: MethodName,
	params?: unknown,
): Promise<T> {
	const frame = await rpc(socketPath, method, params);
	if ("error" in frame) {
		throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`);
	}
	const validated = METHODS[method].validateResult(frame.result);
	if (!validated.ok) {
		throw new Error(
			`${method} result violates its contract at ${validated.field}: ${validated.message}`,
		);
	}
	return validated.value as T;
}

function expectFailure(frame: JsonRpcSuccess | JsonRpcFailure): JsonRpcFailure {
	if (!("error" in frame)) {
		throw new Error(`Expected failure, got success: ${JSON.stringify(frame)}`);
	}
	return frame;
}

/** One agent's wire status, including the hierarchy fields under test. */
async function statusFor(
	socketPath: string,
	name: string,
): Promise<(AgentStatus & { orphaned?: boolean }) | undefined> {
	const status = await call<AgentStatusResult>(socketPath, "agent_status");
	return status.agents.find((agent) => agent.name === name);
}

/**
 * Stop a peer, then start it again under `parent`. Re-parenting is what
 * `agent_spawn` with a `parent` does, and a running peer is returned as-is, so
 * every hierarchy edge in this file is built through this pair.
 */
async function reparent(
	socketPath: string,
	name: string,
	parent: string,
): Promise<AgentSpawnResult> {
	await call<KillResult>(socketPath, "kill", { name });
	return await call<AgentSpawnResult>(socketPath, "agent_spawn", {
		name,
		parent,
	});
}

// ── Parentage is spawn-time state ────────────────────────────────────────────

describe("agent_spawn — parentage", () => {
	test("a child records its parent, and the parent lists it as a child", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		const spawned = await reparent(handle.socketPath, "cto", "ceo");
		expect(spawned.state).toBe("running");

		expect((await statusFor(handle.socketPath, "cto"))?.parent).toBe("ceo");
		expect((await statusFor(handle.socketPath, "ceo"))?.children).toEqual([
			"cto",
		]);
	});

	test("status carries parent and children alongside agent_status", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "cto", "ceo");

		const status = await call<StatusResult>(handle.socketPath, "status");
		const ceo = status.agents.find((agent) => agent.name === "ceo");
		const cto = status.agents.find((agent) => agent.name === "cto");
		expect(cto?.parent).toBe("ceo");
		expect(ceo?.children).toEqual(["cto"]);
		// A root has no parent to report, and reporting one would be a lie the
		// TUI tree would draw.
		expect(ceo?.parent).toBeUndefined();
	});

	test("a child's parent survives a daemon restart", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });

		const first = await boot({ agentDir, projectDir });
		await reparent(first.handle.socketPath, "cto", "ceo");
		await first.handle.close();

		// The definitions on disk say nothing about parentage (ADR-011), so a
		// parent that survives this can only have come from the daemon's own
		// persisted state.
		const second = await boot({ agentDir, projectDir });
		expect((await statusFor(second.handle.socketPath, "cto"))?.parent).toBe(
			"ceo",
		);
		expect(
			(await statusFor(second.handle.socketPath, "ceo"))?.children,
		).toEqual(["cto"]);
	});

	test("an unknown parent is refused", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		await call<KillResult>(handle.socketPath, "kill", { name: "cto" });
		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_spawn", {
				name: "cto",
				parent: "ghost",
			}),
		);
		expect(failure.error.data.field).toBe("parent");
		expect(failure.error.message).toContain("ghost");
	});

	test("a stopped parent is refused: it cannot supervise anything", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		await call<KillResult>(handle.socketPath, "kill", { name: "cto" });
		await call<KillResult>(handle.socketPath, "kill", { name: "ceo" });

		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_spawn", {
				name: "cto",
				parent: "ceo",
			}),
		);
		expect(failure.error.data.field).toBe("parent");
		expect(failure.error.message).toContain("stopped");
	});

	test("a spawn that would close a loop is refused with the loop named", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "alpha", { rooms: ["#a"] });
		await writePeer(agentDir, "beta", { rooms: ["#b"] });
		await writePeer(agentDir, "gamma", { rooms: ["#c"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "beta", "alpha");
		await reparent(handle.socketPath, "gamma", "beta");

		// The whole chain is live, so nothing but the loop itself can be what
		// this refusal is about. alpha under gamma would make alpha its own
		// ancestor.
		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_spawn", {
				name: "alpha",
				parent: "gamma",
			}),
		);
		expect(failure.error.data.field).toBe("parent");
		// The path is what makes this actionable: "rejected" alone leaves the
		// caller guessing which edge closed the loop.
		for (const name of ["alpha", "beta", "gamma"]) {
			expect(failure.error.message).toContain(name);
		}
	});

	test("a cycle is named even when the cascade has stopped the chain", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "alpha", { rooms: ["#a"] });
		await writePeer(agentDir, "beta", { rooms: ["#b"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "beta", "alpha");

		// Killing the root cascades, so every peer a loop runs through is now
		// stopped. "Parent is stopped" is a passing condition a restart fixes;
		// the loop is not, and reporting the transient one would send the caller
		// to restart peers and retry a request that can never succeed.
		await call<KillResult>(handle.socketPath, "kill", { name: "alpha" });

		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_spawn", {
				name: "alpha",
				parent: "beta",
			}),
		);
		expect(failure.error.data.field).toBe("parent");
		// Naming both peers is not enough — "Parent beta is stopped and cannot
		// deploy alpha" also does. The refusal must be about the cycle.
		expect(failure.error.message).toContain("cycle");
		expect(failure.error.message).toContain("alpha -> beta -> alpha");
		expect(failure.error.message).not.toContain("stopped");
	});

	test("a peer cannot be its own parent", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "solo", { rooms: ["#solo"] });
		const { handle } = await boot({ agentDir, projectDir });

		await call<KillResult>(handle.socketPath, "kill", { name: "solo" });
		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_spawn", {
				name: "solo",
				parent: "solo",
			}),
		);
		expect(failure.error.data.field).toBe("parent");
	});
});

// ── Inheritance is narrow, and the negative half is the point ────────────────

describe("agent_spawn — what a child inherits", () => {
	test("a child takes the parent's account, not the one its own model implies", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		// Different providers, so an inherited account is distinguishable from
		// the one the child's own model would have produced.
		await writePeer(agentDir, "ceo", {
			model: "anthropic/claude-sonnet-4-5",
			rooms: ["#board"],
		});
		await writePeer(agentDir, "cto", {
			model: "openai/gpt-5",
			rooms: ["#eng"],
		});
		const { handle } = await boot({ agentDir, projectDir });

		expect((await statusFor(handle.socketPath, "cto"))?.account).toBe("openai");

		await reparent(handle.socketPath, "cto", "ceo");

		expect((await statusFor(handle.socketPath, "cto"))?.account).toBe(
			"anthropic",
		);
	});

	test("the family channel is created for the parent", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		const before = await call<RoomsListResult>(handle.socketPath, "rooms_list");
		expect(before.rooms.map((room) => room.id)).not.toContain("#ceo-team");

		await reparent(handle.socketPath, "cto", "ceo");

		const after = await call<RoomsListResult>(handle.socketPath, "rooms_list");
		expect(after.rooms.map((room) => room.id)).toContain("#ceo-team");
	});

	test("a post in the family channel wakes the child; the parent's room does not", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const booted = await boot({ agentDir, projectDir });

		await reparent(booted.handle.socketPath, "cto", "ceo");
		// The build the daemon is running now: re-parenting rebuilt the worker.
		const child = booted.builds.filter((build) => build.name === "cto").at(-1);

		// Room inheritance would leak an operator-facing channel to every child
		// in the tree, so the parent's own room must not reach this one.
		await call(booted.handle.socketPath, "chat_send", {
			room: "#board",
			body: "board-only matter",
		});
		expect(child?.prompts ?? []).toHaveLength(0);

		await call(booted.handle.socketPath, "chat_send", {
			room: "#ceo-team",
			body: "family standup",
		});
		expect(child?.prompts.join("\n")).toContain("family standup");
	});

	test("a rebuilt child keeps its family channel and does not rebuild again", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const booted = await boot({ agentDir, projectDir });

		await reparent(booted.handle.socketPath, "cto", "ceo");
		const buildsOfChild = (): Build[] =>
			booted.builds.filter((build) => build.name === "cto");
		const afterReparent = buildsOfChild().length;

		// A policy edit forces one rebuild through T-505's staleness check.
		await call<DefinitionUpdateResult>(
			booted.handle.socketPath,
			"definition_update",
			{ name: "cto", changes: { body: "You are a stricter cto." } },
		);
		await call(booted.handle.socketPath, "chat_send", {
			room: "#ceo-team",
			body: "first family post",
		});
		expect(buildsOfChild()).toHaveLength(afterReparent + 1);
		expect(buildsOfChild().at(-1)?.prompts.join("\n")).toContain(
			"first family post",
		);

		// And exactly one: a rebuilt child keeps delivering without restarting
		// again. This holds because `#ensureFresh` moves the peer's membership
		// baseline to the rebuilt worker's own rooms (supervisor.ts:584), so the
		// next comparison comes out equal. It is pinned here rather than assumed
		// because the failure mode is silent and expensive — a child that
		// rebuilds per delivery loses its session on every message.
		await call(booted.handle.socketPath, "chat_send", {
			room: "#ceo-team",
			body: "second family post",
		});
		expect(buildsOfChild()).toHaveLength(afterReparent + 1);
		expect(buildsOfChild().at(-1)?.prompts.join("\n")).toContain(
			"second family post",
		);
	});

	test("a child does not inherit the parent's budget", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		// A shared budget would let one runaway child starve its siblings
		// invisibly (ADR-011), so the parent's cap must not follow the edge.
		await writePeer(agentDir, "ceo", {
			rooms: ["#board"],
			autonomy: { budgetUsd: 5 },
		});
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "cto", "ceo");

		// The child is on the parent's account but declares no ceiling of its
		// own, so bumping that account resumes nothing it owns.
		const bumped = await call<{ resumed: string[] }>(
			handle.socketPath,
			"bump",
			{ account: "anthropic", budgetUsd: 50 },
		);
		expect(bumped.resumed).toEqual([]);
		expect((await statusFor(handle.socketPath, "cto"))?.state).toBe("running");
	});
});

// ── Kill cascades ────────────────────────────────────────────────────────────

describe("kill — cascade and keep-children", () => {
	test("killing a parent stops its whole subtree by default", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		await writePeer(agentDir, "staff", { rooms: ["#staff"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "cto", "ceo");
		await reparent(handle.socketPath, "staff", "cto");

		await call<KillResult>(handle.socketPath, "kill", { name: "ceo" });

		// Grandchildren too: orphanhood must be impossible, not merely rare.
		expect((await statusFor(handle.socketPath, "ceo"))?.state).toBe("stopped");
		expect((await statusFor(handle.socketPath, "cto"))?.state).toBe("stopped");
		expect((await statusFor(handle.socketPath, "staff"))?.state).toBe(
			"stopped",
		);
	});

	test("a cascade leaves an unrelated root running", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		await writePeer(agentDir, "solo", { rooms: ["#solo"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "cto", "ceo");
		await call<KillResult>(handle.socketPath, "kill", { name: "ceo" });

		expect((await statusFor(handle.socketPath, "solo"))?.state).toBe("running");
	});

	test("keep_children stops only the parent and reparents children to root", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "cto", "ceo");

		await call<KillResult>(handle.socketPath, "kill", {
			name: "ceo",
			keep_children: true,
		});

		expect((await statusFor(handle.socketPath, "ceo"))?.state).toBe("stopped");
		const cto = await statusFor(handle.socketPath, "cto");
		expect(cto?.state).toBe("running");
		// Reparented to root, not left pointing at a corpse.
		expect(cto?.parent).toBeUndefined();
		expect((await statusFor(handle.socketPath, "ceo"))?.children).toEqual([]);
	});

	test("a malformed keep_children is refused, never silently cascaded", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		const { handle } = await boot({ agentDir, projectDir });

		await reparent(handle.socketPath, "cto", "ceo");

		// `kill` is destructive and its default is the cascade, so a
		// `keep_children` the daemon cannot read must not be treated as absent:
		// that turns "spare my children" into "kill the subtree", which is both
		// the opposite of the request and unrecoverable.
		const failure = expectFailure(
			await rpc(handle.socketPath, "kill", {
				name: "ceo",
				keep_children: "true",
			}),
		);
		expect(failure.error.data.field).toBe("keep_children");

		// Refused means nothing happened, not "happened the other way".
		expect((await statusFor(handle.socketPath, "ceo"))?.state).toBe("running");
		expect((await statusFor(handle.socketPath, "cto"))?.state).toBe("running");
		expect((await statusFor(handle.socketPath, "cto"))?.parent).toBe("ceo");
	});

	test("a keep-children reparent survives a restart", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });

		const first = await boot({ agentDir, projectDir });
		await reparent(first.handle.socketPath, "cto", "ceo");
		await call<KillResult>(first.handle.socketPath, "kill", {
			name: "ceo",
			keep_children: true,
		});
		await first.handle.close();

		// A reparent written only to memory would come back as the old edge and
		// resurrect a parent the operator explicitly detached.
		const second = await boot({ agentDir, projectDir });
		expect(
			(await statusFor(second.handle.socketPath, "cto"))?.parent,
		).toBeUndefined();
	});
});

// ── Tree reads on the persisted registry ─────────────────────────────────────

describe("DaemonDb — tree reads", () => {
	test("children, ancestors, and orphans are read from the stored edges", async () => {
		const dir = await tempDir();
		const db = await DaemonDb.open(join(dir, "tree.db"));
		cleanups.push(async () => db.close());

		const row = (name: string, parent: string | null) => ({
			name,
			definitionPath: `/peers/${name}.md`,
			status: "running" as const,
			workerPid: null,
			cwd: "/project",
			startedAt: 1,
			parent,
		});
		// ceo <- cto <- staff, plus an unrelated root.
		db.upsertAgent(row("ceo", null));
		db.upsertAgent(row("cto", "ceo"));
		db.upsertAgent(row("staff", "cto"));
		db.upsertAgent(row("solo", null));

		expect(db.childrenOf("ceo")).toEqual(["cto"]);
		expect(db.childrenOf("staff")).toEqual([]);
		// Nearest first, so a caller can name the closest broken edge.
		expect(db.ancestorsOf("staff")).toEqual(["cto", "ceo"]);
		expect(db.ancestorsOf("ceo")).toEqual([]);

		// Everything resolves while every peer is still known.
		expect(db.listOrphans(["ceo", "cto", "staff", "solo"])).toEqual([]);

		// Drop the root: both descendants are orphaned, and each names the
		// ancestor that actually went missing rather than its own parent.
		expect(db.listOrphans(["cto", "staff", "solo"])).toEqual([
			{ name: "cto", missing: "ceo" },
			{ name: "staff", missing: "ceo" },
		]);

		// A peer with no definition left is not itself reported: it is gone, not
		// orphaned, and the sweep that removes its worker dir is a separate job.
		expect(db.listOrphans(["staff", "solo"])).toEqual([
			{ name: "staff", missing: "cto" },
		]);
	});
});

// ── Orphan refusal at boot ───────────────────────────────────────────────────

describe("boot — orphan refusal", () => {
	test("an agent whose parent is gone is not started and is flagged orphaned", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });

		const first = await boot({ agentDir, projectDir });
		await reparent(first.handle.socketPath, "cto", "ceo");
		await first.handle.close();

		// The parent's definition leaves the store between boots.
		await rm(join(agentDir, "oh-my-agent", "agents", "ceo.md"));

		const second = await boot({ agentDir, projectDir });
		const cto = await statusFor(second.handle.socketPath, "cto");
		expect(cto).toBeDefined();
		expect(cto?.orphaned).toBe(true);
		expect(cto?.state).toBe("stopped");
		expect(cto?.parent).toBe("ceo");

		// Refused, not resumed: no worker was ever built for it.
		expect(second.builds.some((build) => build.name === "cto")).toBe(false);
	});

	test("a root agent still boots normally when a sibling is orphaned", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		await writePeer(agentDir, "solo", { rooms: ["#solo"] });

		const first = await boot({ agentDir, projectDir });
		await reparent(first.handle.socketPath, "cto", "ceo");
		await first.handle.close();
		await rm(join(agentDir, "oh-my-agent", "agents", "ceo.md"));

		const second = await boot({ agentDir, projectDir });
		expect((await statusFor(second.handle.socketPath, "solo"))?.state).toBe(
			"running",
		);
		expect(second.builds.some((build) => build.name === "solo")).toBe(true);
	});

	test("a whole orphaned subtree is refused, not just the direct child", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		await writePeer(agentDir, "cto", { rooms: ["#eng"] });
		await writePeer(agentDir, "staff", { rooms: ["#staff"] });

		const first = await boot({ agentDir, projectDir });
		await reparent(first.handle.socketPath, "cto", "ceo");
		await reparent(first.handle.socketPath, "staff", "cto");
		await first.handle.close();

		await rm(join(agentDir, "oh-my-agent", "agents", "ceo.md"));

		// The grandchild's own parent still exists, so an orphan check that
		// looks only one level up calls `staff` startable — and then starts it
		// under a peer that was itself refused, which is the running-under-a-
		// ghost state the refusal exists to prevent.
		const second = await boot({ agentDir, projectDir });
		const staff = await statusFor(second.handle.socketPath, "staff");
		expect(staff?.orphaned).toBe(true);
		expect(staff?.state).toBe("stopped");
		expect(second.builds.some((build) => build.name === "staff")).toBe(false);

		// Its parent is still `cto`, the peer that actually deployed it — not
		// `ceo`, the ancestor whose disappearance broke the chain. Reporting the
		// missing ancestor here would draw an edge that never existed.
		expect(staff?.parent).toBe("cto");
		expect((await statusFor(second.handle.socketPath, "cto"))?.parent).toBe(
			"ceo",
		);
	});
});

// ── Authoring over the real socket ───────────────────────────────────────────

describe("agent_create / definition_get / definition_update", () => {
	test("create writes a parse-validated definition the store then serves", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writeTaskAgent(agentDir);
		const { handle } = await boot({ agentDir, projectDir });

		const created = await call<AgentCreateResult>(
			handle.socketPath,
			"agent_create",
			{
				name: "qa",
				description: "Checks the work.",
				model: ["anthropic/claude-sonnet-4-5"],
				spawns: ["scout"],
				rooms: ["#qa"],
				body: "You are qa.",
			},
		);
		expect(created).toEqual({ name: "qa", created: true });

		const fetched = await call<DefinitionGetResult>(
			handle.socketPath,
			"definition_get",
			{ name: "qa" },
		);
		expect(fetched.name).toBe("qa");
		expect(fetched.definition.description).toBe("Checks the work.");
		expect(fetched.definition.rooms).toEqual(["#qa"]);
		// Written into the project store, atomically, by the peer store path.
		expect(fetched.filePath).toBe(
			join(projectDir, ".omp", "oh-my-agent", "agents", "qa.md"),
		);
	});

	test("a created peer can then be spawned, including under a parent", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "ceo", { rooms: ["#board"] });
		const { handle } = await boot({ agentDir, projectDir });

		await call<AgentCreateResult>(handle.socketPath, "agent_create", {
			name: "qa",
			description: "Checks the work.",
			model: ["anthropic/claude-sonnet-4-5"],
			spawns: ["scout"],
			rooms: ["#qa"],
			body: "You are qa.",
		});

		// Two calls, per ADR-011: creation validates, spawn starts.
		const spawned = await call<AgentSpawnResult>(
			handle.socketPath,
			"agent_spawn",
			{ name: "qa", parent: "ceo" },
		);
		expect(spawned).toEqual({ name: "qa", state: "running" });
		expect((await statusFor(handle.socketPath, "qa"))?.parent).toBe("ceo");
	});

	test("a definition that does not parse is refused before anything lands", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writeTaskAgent(agentDir);
		const { handle } = await boot({ agentDir, projectDir });

		// No `spawns:`: the strict parser rejects it, which is the validation
		// checkpoint creation exists to provide.
		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_create", {
				name: "broken",
				description: "No spawns.",
				body: "You are broken.",
			}),
		);
		expect(failure.error.message.toLowerCase()).toContain("spawns");

		// Nothing landed: the store has no such peer to serve.
		expectFailure(
			await rpc(handle.socketPath, "definition_get", { name: "broken" }),
		);
	});

	test("creating over an existing name is refused", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writeTaskAgent(agentDir);
		const { handle } = await boot({ agentDir, projectDir });

		const fields = {
			name: "qa",
			description: "Checks the work.",
			model: ["anthropic/claude-sonnet-4-5"],
			spawns: ["scout"],
			rooms: ["#qa"],
			body: "You are qa.",
		};
		await call<AgentCreateResult>(handle.socketPath, "agent_create", fields);
		const failure = expectFailure(
			await rpc(handle.socketPath, "agent_create", fields),
		);
		expect(failure.error.message).toContain("qa");
	});

	test("definition_get on an unknown peer names the field", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		const { handle } = await boot({ agentDir, projectDir });

		const failure = expectFailure(
			await rpc(handle.socketPath, "definition_get", { name: "ghost" }),
		);
		expect(failure.error.data.field).toBe("name");
	});

	test("a membership-only update is not a rebuild", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "reviewer", { rooms: ["#reviews"] });
		const { handle } = await boot({ agentDir, projectDir });

		// Rooms are membership, not policy: the supervisor applies them live,
		// so a room change must not claim a restart is required.
		const updated = await call<DefinitionUpdateResult>(
			handle.socketPath,
			"definition_update",
			{ name: "reviewer", changes: { rooms: ["#reviews", "#extra"] } },
		);
		expect(updated).toEqual({ name: "reviewer", rebuildRequired: false });

		const fetched = await call<DefinitionGetResult>(
			handle.socketPath,
			"definition_get",
			{ name: "reviewer" },
		);
		expect(fetched.definition.rooms).toEqual(["#reviews", "#extra"]);
	});

	test("a policy-changing update reports rebuildRequired and rebuilds on next delivery", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "reviewer", { rooms: ["#reviews"] });
		const booted = await boot({ agentDir, projectDir });

		await call(booted.handle.socketPath, "chat_send", {
			room: "#reviews",
			body: "first message",
		});
		expect(booted.builds).toHaveLength(1);
		expect(booted.builds[0]?.prompts.join("\n")).toContain("first message");

		const updated = await call<DefinitionUpdateResult>(
			booted.handle.socketPath,
			"definition_update",
			{ name: "reviewer", changes: { body: "You are a stricter reviewer." } },
		);
		expect(updated).toEqual({ name: "reviewer", rebuildRequired: true });

		// The rebuild itself is T-505's: the update restarts nothing, it is
		// answered by the next delivery going to a freshly built worker.
		expect(booted.builds).toHaveLength(1);

		await call(booted.handle.socketPath, "chat_send", {
			room: "#reviews",
			body: "second message",
		});

		expect(booted.builds).toHaveLength(2);
		expect(booted.builds[0]?.stopped).toBe(true);
		expect(booted.builds[1]?.prompts.join("\n")).toContain("second message");
	});

	test("definition_update on an unknown peer names the field", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		const { handle } = await boot({ agentDir, projectDir });

		const failure = expectFailure(
			await rpc(handle.socketPath, "definition_update", {
				name: "ghost",
				changes: { description: "nope" },
			}),
		);
		expect(failure.error.data.field).toBe("name");
	});
});
