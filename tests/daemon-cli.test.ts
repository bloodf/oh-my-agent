/**
 * Tests for src/daemon/cli.ts (T-1103). Covers every verb against a real
 * `bootDaemon` handle, daemon-down, --json shape, exit codes, and the
 * `console` verb's three branches (URL file present, daemon up but console
 * disabled, daemon down).
 *
 * Harness mirrors tests/daemon-main.test.ts (per ADR-008 — tests call
 * production builders). One Bun.spawn end-to-end test runs the real
 * `src/daemon/main.ts` binary against a temp agent dir with no daemon to
 * prove exit code 3 at the process boundary.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runCli } from "../src/daemon/cli";
import type { WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import type {
	AgentStatusResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	KillResult,
	MethodName,
	SchedulesListResult,
} from "../src/shared/protocol";
import { METHODS } from "../src/shared/protocol-schemas";
import { controlCall, operatorToken } from "./fixtures/control-client";
import { hermeticChildEnv } from "./fixtures/hermetic-env";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-cli-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

interface CapturedIo {
	stdout: string;
	stderr: string;
	log: string[];
	err: string[];
}

function makeIo(): CapturedIo {
	return { stdout: "", stderr: "", log: [], err: [] };
}

async function writePeer(
	agentDir: string,
	name: string,
	frontmatter: Record<string, unknown> = {},
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
		model: "anthropic/claude-sonnet-4-5",
		spawns: ["scout"],
		rooms: ["#reviews"],
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
	state: () => "running" | "parked" | "stopped";
}

function stubWorkerFactory(): {
	factory: WorkerFactory;
	workers: Map<string, StubWorker>;
} {
	const workers = new Map<string, StubWorker>();

	const factory: WorkerFactory = async ({ peer }) => {
		const prompts: string[] = [];
		let state: "running" | "parked" | "stopped" = "running";
		workers.set(peer.name, {
			prompts,
			state: () => state,
		});

		return {
			name: peer.name,
			get state() {
				return state;
			},
			prompt: async (message) => {
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

interface BootResult {
	handle: Awaited<ReturnType<typeof bootDaemon>>;
	agentDir: string;
	workers: Map<string, StubWorker>;
}

async function bootWith(
	agentDir: string,
	env: Record<string, string | undefined> = {},
): Promise<BootResult> {
	const stub = stubWorkerFactory();
	const handle = await bootDaemon({
		env: { ...env },
		agentDir,
		projectDir: agentDir,
		workerFactory: stub.factory,
	});
	cleanups.push(() => handle.close());
	return { handle, agentDir, workers: stub.workers };
}

async function call<T>(
	socketPath: string,
	method: MethodName,
	params: unknown = {},
	id: number | string = 1,
): Promise<T> {
	const frame = (await controlCall(
		socketPath,
		method,
		params,
		await operatorToken(dirname(socketPath)),
		id,
	)) as JsonRpcSuccess | JsonRpcFailure;
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

// ── Verb coverage ────────────────────────────────────────────────────────────

describe("omp-agent CLI — every verb round-trips against a real daemon", () => {
	test("status, agents, spawn, rooms, schedule, logs, inject, bump", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "parent", { model: "openai/gpt-4.1" });
		await writePeer(agentDir, "reviewer", {
			model: "anthropic/claude-sonnet-4-5",
			autonomy: { budgetUsd: 10 },
		});
		const { workers } = await bootWith(agentDir);

		// `status`
		const status = await runCapture(["status"], { agentDir });
		expect(status.code).toBe(0);
		expect(status.io.stdout).toContain("protocol:");
		expect(status.io.stderr).toBe("");

		// `agents`
		const agents = await runCapture(["agents"], { agentDir });
		expect(agents.code).toBe(0);
		expect(agents.io.stdout).toContain("reviewer");
		expect(agents.io.stderr).toBe("");

		// `spawn reviewer --parent parent` — `parent` is a real, running peer
		// in the registry, so the daemon accepts the edge.
		const spawnIo = await runCapture(
			["spawn", "reviewer", "--parent", "parent"],
			{ agentDir },
		);
		expect(spawnIo.code).toBe(0);
		expect(spawnIo.io.stderr).toBe("");

		// `rooms`
		const rooms = await runCapture(["rooms"], { agentDir });
		expect(rooms.code).toBe(0);
		expect(rooms.io.stdout).toContain("#reviews");
		expect(rooms.io.stderr).toBe("");

		// `rooms post` + `rooms read`
		const posted = await runCapture(
			["rooms", "post", "#reviews", "hello via cli"],
			{ agentDir },
		);
		expect(posted.code).toBe(0);
		expect(posted.io.stderr).toBe("");
		expect(workers.get("reviewer")?.prompts.join("\n")).toContain(
			"hello via cli",
		);

		const read = await runCapture(["rooms", "read", "#reviews"], { agentDir });
		expect(read.code).toBe(0);
		expect(read.io.stdout).toContain("hello via cli");
		expect(read.io.stderr).toBe("");

		// `schedule` (list) + `schedule <id> off`
		const list = await runCapture(["schedule"], { agentDir });
		expect(list.code).toBe(0);
		// `reviewer` has no `schedules:` frontmatter, so an empty list is
		// acceptable. The verb must succeed.
		expect(list.io.stderr).toBe("");

		// `logs`
		const logs = await runCapture(["logs", "reviewer"], { agentDir });
		expect(logs.code).toBe(0);
		expect(logs.io.stderr).toBe("");

		const logs2 = await runCapture(["logs", "reviewer", "3"], { agentDir });
		expect(logs2.code).toBe(0);
		expect(logs2.io.stderr).toBe("");

		// `inject`
		const inj = await runCapture(["inject", "reviewer", "wake up and check"], {
			agentDir,
		});
		expect(inj.code).toBe(0);
		expect(inj.io.stderr).toBe("");

		// `bump`
		const bumped = await runCapture(["bump", "anthropic", "50"], { agentDir });
		expect(bumped.code).toBe(0);
		expect(bumped.io.stderr).toBe("");

		// `kill` without --keep-children
		const killed = await runCapture(["kill", "reviewer"], { agentDir });
		expect(killed.code).toBe(0);
		expect(killed.io.stderr).toBe("");
		expect(workers.get("reviewer")?.state()).toBe("stopped");
	});

	test("schedule <id> on|off arms a schedule from a peer's definition", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer", {
			schedules: [{ cron: "0 9 * * *", prompt: "morning", room: "#reviews" }],
		});
		const { handle } = await bootWith(agentDir);

		const listed = await call<SchedulesListResult>(
			handle.socketPath,
			"schedules_list",
		);
		const id = listed.schedules[0]?.id;
		expect(id).toBeDefined();

		const off = await runCapture(["schedule", id as string, "off"], {
			agentDir,
		});
		expect(off.code).toBe(0);
		expect(off.io.stderr).toBe("");

		const on = await runCapture(["schedule", id as string, "on"], {
			agentDir,
		});
		expect(on.code).toBe(0);
		expect(on.io.stderr).toBe("");
	});

	test("bad args exit 2 (usage)", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		await bootWith(agentDir);

		for (const argv of [
			["logs", "reviewer", "abc"],
			["logs", "reviewer", "0"],
			["logs", "reviewer", "-1"],
			["bump", "anthropic", "abc"],
			["kill"],
			["spawn"],
			["schedule", "id", "maybe"],
			["rooms", "read"],
			["rooms", "post"],
		] as const) {
			const result = await runCapture([...argv], { agentDir });
			expect(result.code).toBe(2);
			expect(result.io.stderr).toContain("Usage:");
		}
	});
});

// ── Daemon down ──────────────────────────────────────────────────────────────

describe("omp-agent CLI — daemon down", () => {
	test("exit 3, DAEMON_DOWN on stderr, stdout empty", async () => {
		const agentDir = await tempAgentDir();
		// Intentionally no boot.
		const result = await runCapture(["status"], { agentDir });

		expect(result.code).toBe(3);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
	});
});

// ── --json shape ─────────────────────────────────────────────────────────────

describe("omp-agent CLI — --json matches the protocol result", () => {
	const scheduleArgs = async (
		{ handle }: BootResult,
		enabled: "on" | "off",
	): Promise<string[]> => {
		const listed = await call<SchedulesListResult>(
			handle.socketPath,
			"schedules_list",
		);
		const id = listed.schedules[0]?.id;
		if (id === undefined) throw new Error("expected a schedule fixture");
		return ["schedule", id, enabled];
	};

	test.each([
		{ label: "status", argv: () => ["status"] },
		{ label: "agents", argv: () => ["agents"] },
		{
			label: "spawn",
			argv: () => ["spawn", "reviewer", "--parent", "parent"],
		},
		{ label: "kill", argv: () => ["kill", "reviewer"] },
		{ label: "rooms", argv: () => ["rooms"] },
		{
			label: "rooms post",
			argv: () => ["rooms", "post", "#reviews", "hello via json"],
		},
		{
			label: "rooms read",
			argv: () => ["rooms", "read", "#reviews"],
		},
		{ label: "schedule", argv: () => ["schedule"] },
		{
			label: "schedule on",
			argv: (boot: BootResult) => scheduleArgs(boot, "on"),
		},
		{
			label: "schedule off",
			argv: (boot: BootResult) => scheduleArgs(boot, "off"),
		},
		{ label: "logs", argv: () => ["logs", "reviewer"] },
		{
			label: "inject",
			argv: () => ["inject", "reviewer", "wake up via json"],
		},
		{ label: "bump", argv: () => ["bump", "anthropic", "50"] },
	])("$label --json parses as JSON", async ({ argv }) => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "parent", { model: "openai/gpt-4.1" });
		await writePeer(agentDir, "reviewer", {
			model: "anthropic/claude-sonnet-4-5",
			autonomy: { budgetUsd: 10 },
			schedules: [{ cron: "0 9 * * *", prompt: "morning", room: "#reviews" }],
		});
		const boot = await bootWith(agentDir);

		const result = await runCapture(["--json", ...(await argv(boot))], {
			agentDir,
		});

		expect(result.code).toBe(0);
		expect(result.io.stderr).toBe("");
		expect(() => JSON.parse(result.io.stdout)).not.toThrow();
	});

	test("console --json is the sole exception and prints the raw URL", async () => {
		const agentDir = await tempAgentDir();
		await bootWith(agentDir);
		const urlPath = join(agentDir, "oh-my-agent", "console-url");
		const url = (await Bun.file(urlPath).text()).trim();

		const result = await runCapture(["--json", "console"], { agentDir });

		expect(result.code).toBe(0);
		expect(result.io.stdout.trim()).toBe(url);
		expect(() => JSON.parse(result.io.stdout)).toThrow();
	});
});

// ── Usage text ───────────────────────────────────────────────────────────────

describe("omp-agent CLI — usage text", () => {
	test("unknown verb exits 2 with usage listing real verbs", async () => {
		const agentDir = await tempAgentDir();
		const result = await runCapture(["nope"], { agentDir });

		expect(result.code).toBe(2);
		expect(result.io.stderr).toContain("Usage:");
		for (const verb of ["status", "agents", "kill", "console", "rooms"]) {
			expect(result.io.stderr).toContain(verb);
		}
	});
});

// ── Scripting scenario ──────────────────────────────────────────────────────

describe("omp-agent CLI — scripting: parent/child tree, post and read", () => {
	test("spawn with --parent, post into a room, read it back, see the tree", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "parent");
		await writePeer(agentDir, "child", { rooms: ["#reviews"] });
		const { workers } = await bootWith(agentDir);

		// bootDaemon starts every defined peer; stop child first so spawn can
		// recreate it under parent through the CLI.
		const stopped = await runCapture(["kill", "child"], { agentDir });
		expect(stopped.code).toBe(0);

		const spawn = await runCapture(["spawn", "child", "--parent", "parent"], {
			agentDir,
		});
		expect(spawn.code).toBe(0);

		const post = await runCapture(
			["rooms", "post", "#reviews", "first message"],
			{ agentDir },
		);
		expect(post.code).toBe(0);

		const read = await runCapture(["rooms", "read", "#reviews"], { agentDir });
		expect(read.code).toBe(0);
		expect(read.io.stdout).toContain("first message");

		const agents = await runCapture(["--json", "agents"], { agentDir });
		expect(agents.code).toBe(0);
		const parsed = JSON.parse(agents.io.stdout) as AgentStatusResult;
		const byName = new Map(parsed.agents.map((a) => [a.name, a]));
		const childRow = byName.get("child");
		expect(childRow?.parent).toBe("parent");
		const parentRow = byName.get("parent");
		expect(parentRow?.children).toContain("child");

		// Stub at least one worker was actually registered.
		expect(workers.has("child")).toBe(true);
	});
});

// ── bearer failures ───────────────────────────────────────────────────────────

describe("omp-agent CLI — operator bearer", () => {
	test("a live daemon with a missing token file returns its Unauthorized error", async () => {
		const agentDir = await tempAgentDir();
		const { handle } = await bootWith(agentDir);
		await rm(join(dirname(handle.socketPath), "console-token"));

		const result = await runCapture(["status"], { agentDir });
		expect(result.code).toBe(4);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toBe("Unauthorized\n");
	});

	test("a dead socket with no token file remains daemon-down", async () => {
		const agentDir = await tempAgentDir();
		const result = await runCapture(["status"], { agentDir });
		expect(result.code).toBe(3);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
	});
});

// ── End-to-end via Bun.spawn on the real binary ─────────────────────────────

describe("omp-agent CLI — end-to-end via the real binary", () => {
	test("exit 3 when no daemon is running, with the daemon-down sentence on stderr", async () => {
		const agentDir = await tempAgentDir();
		const mainPath = join(import.meta.dir, "..", "src", "daemon", "main.ts");

		const proc = Bun.spawn({
			cmd: [process.execPath, mainPath, "status"],
			env: hermeticChildEnv({
				PI_CODING_AGENT_DIR: agentDir,
				OMP_AUTH_BROKER_URL: "",
				OMP_AUTH_BROKER_TOKEN: "",
			}),
			cwd: agentDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		expect(exitCode).toBe(3);
		expect(stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
	}, 30_000);
});

// ─-- keep-children reaches the daemon unvalidated --──────────────────────────

describe("omp-agent CLI — kill --keep-children", () => {
	test("the keep_children key reaches the daemon as-is, no client-side rejection", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		const { handle, workers } = await bootWith(agentDir);

		// CLI must pass it through literally.
		const cli = await runCapture(["kill", "reviewer", "--keep-children"], {
			agentDir,
		});
		expect(cli.code).toBe(0);
		expect(cli.io.stderr).toBe("");

		// Raw call with keep_children: true works (the server validates it).
		const raw = await call<KillResult>(handle.socketPath, "kill", {
			name: "reviewer",
			keep_children: true,
		});
		expect(raw.state).toBe("stopped");

		// A non-boolean keep_children still fails server-side — proving the
		// CLI does not invent client-side rejection of the field.
		const frame = (await controlCall(
			handle.socketPath,
			"kill",
			{ name: "reviewer", keep_children: "yes" },
			await operatorToken(dirname(handle.socketPath)),
			99,
		)) as JsonRpcFailure;
		expect("error" in frame).toBe(true);
		if ("error" in frame) {
			expect(frame.error.data.field).toBe("keep_children");
		}

		expect(workers.get("reviewer")?.state()).toBe("stopped");
	});
});

// ── console verb ────────────────────────────────────────────────────────────

describe("omp-agent CLI — console verb", () => {
	test("URL file present → prints the URL", async () => {
		const agentDir = await tempAgentDir();
		await bootWith(agentDir);

		const urlPath = join(agentDir, "oh-my-agent", "console-url");
		expect(existsSync(urlPath)).toBe(true);

		const result = await runCapture(["console"], { agentDir });
		expect(result.code).toBe(0);
		expect(result.io.stdout.trim()).toBe(
			(await Bun.file(urlPath).text()).trim(),
		);
		expect(result.io.stderr).toBe("");
	});

	test("close removes the persisted URL", async () => {
		const agentDir = await tempAgentDir();
		const { handle } = await bootWith(agentDir);
		const urlPath = join(agentDir, "oh-my-agent", "console-url");
		expect(existsSync(urlPath)).toBe(true);

		await handle.close();
		expect(existsSync(urlPath)).toBe(false);
	});

	test("daemon up but console disabled → exit 4, console-disabled message", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		await bootWith(agentDir, { OMA_CONSOLE: "0" });

		const urlPath = join(agentDir, "oh-my-agent", "console-url");
		expect(existsSync(urlPath)).toBe(false);

		const result = await runCapture(["console"], { agentDir });
		expect(result.code).toBe(4);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain("disabled");
	});

	test("a stale URL left on disk is removed when this boot's console is off", async () => {
		const agentDir = await tempAgentDir();
		const urlPath = join(agentDir, "oh-my-agent", "console-url");

		// Simulate crash debris: a URL file surviving from an earlier boot that
		// had the console on, with no daemon running to have cleaned it up.
		await mkdir(join(agentDir, "oh-my-agent"), { recursive: true });
		await writeFile(urlPath, "http://127.0.0.1:9999/?token=stale", "utf8");
		expect(existsSync(urlPath)).toBe(true);

		await bootWith(agentDir, { OMA_CONSOLE: "0" });
		expect(existsSync(urlPath)).toBe(false);
	});

	test("daemon down → exit 3 with the daemon-down sentence", async () => {
		const agentDir = await tempAgentDir();
		const result = await runCapture(["console"], { agentDir });
		expect(result.code).toBe(3);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
	});
});

// ── CLI capture ─────────────────────────────────────────────────────────────

interface RunResult {
	code: number;
	io: CapturedIo;
}

async function runCapture(
	argv: string[],
	opts: { agentDir: string },
): Promise<RunResult> {
	let stdout = "";
	let stderr = "";
	const io: CapturedIo = {
		stdout,
		stderr,
		log: [],
		err: [],
	};
	const writeOut = (line: string) => {
		io.log.push(line);
		stdout += line.endsWith("\n") ? line : `${line}\n`;
		io.stdout = stdout;
	};
	const writeErr = (line: string) => {
		io.err.push(line);
		stderr += line.endsWith("\n") ? line : `${line}\n`;
		io.stderr = stderr;
	};
	const code = await runCli(argv, {
		agentDir: opts.agentDir,
		io: { stdout: writeOut, stderr: writeErr },
	});
	return { code, io };
}

void makeIo;
