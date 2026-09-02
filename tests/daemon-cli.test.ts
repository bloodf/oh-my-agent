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
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
	LogsTailResult,
	MethodName,
	SchedulesListResult,
	StatusResult,
} from "../src/shared/protocol";
import { PROTOCOL_VERSION } from "../src/shared/protocol";
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

/**
 * Whether a pid still names a live process. Three call sites need the same
 * answer, and the EPERM branch is the non-obvious half: a process owned by
 * another user exists, so refusing the signal is proof of life, not absence.
 */
function alive(pid: number): boolean {
	try {
		// Signal 0 checks for existence without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Launch a real detached daemon over `agentDir`, ready to answer on return.
 *
 * The in-process `bootWith` harness cannot stand in here: `daemon stop` waits
 * for the pid named in the pidfile to stop existing, and an in-process daemon's
 * pid is this test runner's own — it would wait out its deadline on a process
 * that cannot exit until the suite does.
 *
 * Readiness needs no polling. `bootDaemon` claims the pidfile and serves the
 * control socket before it calls `announce`, and the launcher blocks on exactly
 * that announcement, so the launcher's own exit is the readiness event: by the
 * time it returns, the pidfile is written and the socket is bound.
 */
async function spawnDaemon(
	agentDir: string,
): Promise<{ pid: number; socketPath: string }> {
	const mainPath = join(import.meta.dir, "..", "src", "daemon", "main.ts");
	const launcher = Bun.spawn({
		cmd: [process.execPath, mainPath, "daemon"],
		env: hermeticChildEnv({
			PI_CODING_AGENT_DIR: agentDir,
			OMP_AUTH_BROKER_URL: "",
			OMP_AUTH_BROKER_TOKEN: "",
		}),
		cwd: agentDir,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exitCode = await launcher.exited;
	const stdout = await new Response(launcher.stdout).text();
	const stderr = await new Response(launcher.stderr).text();
	if (exitCode !== 0) {
		throw new Error(
			`launcher exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}

	const stateDir = join(agentDir, "oh-my-agent");
	const socketPath = join(stateDir, "daemon.sock");
	const pid = Number(
		(await Bun.file(join(stateDir, "daemon.pid")).text()).trim(),
	);
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(
			`detached daemon wrote no usable pidfile\nstderr: ${stderr}`,
		);
	}
	cleanups.push(async () => {
		if (!alive(pid)) return;
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Exited between the check and the signal.
		}
	});

	// The socket is bound before `announce`, so one call proves it answers
	// rather than merely existing — and it throws here, at the harness, if the
	// readiness contract above ever stops holding.
	await call(socketPath, "status");
	return { pid, socketPath };
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

// ── Lifecycle verbs ─────────────────────────────────────────────────────────

describe("omp-agent CLI — daemon stop", () => {
	test("stops a live daemon and returns once the pidfile and process are gone", async () => {
		const agentDir = await tempAgentDir();
		const { pid, socketPath } = await spawnDaemon(agentDir);
		const pidPath = join(agentDir, "oh-my-agent", "daemon.pid");

		const result = await runCapture(["daemon", "stop"], { agentDir });

		expect(result.code).toBe(0);
		expect(result.io.stderr).toBe("");
		// Verified gone, not merely asked to go: the CLI's whole contract here
		// is that it does not return until both are true.
		expect(existsSync(pidPath)).toBe(false);
		expect(alive(pid)).toBe(false);
		expect(existsSync(socketPath)).toBe(false);
	}, 60_000);

	test("refuses a stale pidfile without claiming it stopped anything", async () => {
		const agentDir = await tempAgentDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await mkdir(stateDir, { recursive: true });

		// A pid that cannot be alive: spawn a child, reap it, reuse its pid.
		const corpse = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		await corpse.exited;
		const pidPath = join(stateDir, "daemon.pid");
		await writeFile(pidPath, String(corpse.pid), "utf8");

		const result = await runCapture(["daemon", "stop"], { agentDir });

		// No socket to reach, so this is the daemon-down condition — and the
		// stale pidfile must survive, because deleting another profile's
		// bookkeeping on a guess is exactly what pidfile ownership prevents.
		expect(result.code).toBe(3);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
		expect(existsSync(pidPath)).toBe(true);
	});

	test("daemon down → exit 3 with the daemon-down sentence", async () => {
		const agentDir = await tempAgentDir();
		const result = await runCapture(["daemon", "stop"], { agentDir });
		expect(result.code).toBe(3);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
	});

	test("bad lifecycle args exit 2 with usage", async () => {
		const agentDir = await tempAgentDir();
		for (const argv of [
			["daemon", "stop", "extra"],
			["daemon", "restart", "extra"],
			["daemon", "wobble"],
		]) {
			const result = await runCapture(argv, { agentDir });
			expect(result.code).toBe(2);
			expect(result.io.stderr).toContain("Usage:");
		}
	});

	test("the real binary routes `daemon stop` to the CLI, never to a boot", async () => {
		// `runCli` in-process cannot see this: the bug lives in main.ts's own
		// entry dispatch, where routing on the verb alone sends `daemon stop`
		// into the detached launcher and starts a second daemon instead of
		// stopping the first. Only the real binary exercises that branch.
		const agentDir = await tempAgentDir();
		const { pid } = await spawnDaemon(agentDir);
		const pidPath = join(agentDir, "oh-my-agent", "daemon.pid");
		const mainPath = join(import.meta.dir, "..", "src", "daemon", "main.ts");

		const proc = Bun.spawn({
			cmd: [process.execPath, mainPath, "daemon", "stop"],
			env: hermeticChildEnv({
				PI_CODING_AGENT_DIR: agentDir,
				OMP_AUTH_BROKER_URL: "",
				OMP_AUTH_BROKER_TOKEN: "",
			}),
			cwd: agentDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		expect(exitCode).toBe(0);
		expect(stdout).toContain("stopped");
		// A boot would have announced a socket path and left a daemon running.
		expect(stdout).not.toContain("daemon.sock");
		expect(stderr).toBe("");
		expect(alive(pid)).toBe(false);
		expect(existsSync(pidPath)).toBe(false);
	}, 90_000);
});

describe("omp-agent CLI — daemon restart", () => {
	test("replaces the running daemon with a new live one", async () => {
		const agentDir = await tempAgentDir();
		const { pid: first, socketPath } = await spawnDaemon(agentDir);
		const pidPath = join(agentDir, "oh-my-agent", "daemon.pid");

		const result = await runCapture(["daemon", "restart"], { agentDir });
		expect(result.code).toBe(0);
		expect(result.io.stderr).toBe("");

		const second = Number((await Bun.file(pidPath).text()).trim());
		cleanups.push(async () => {
			if (!alive(second)) return;
			try {
				process.kill(second, "SIGTERM");
			} catch {
				// Exited between the check and the signal.
			}
		});

		// A restart that reported success while reusing the old process, or
		// left the old one alive beside the new one, is the failure this pins.
		expect(second).not.toBe(first);
		expect(alive(first)).toBe(false);
		expect(alive(second)).toBe(true);

		// And the replacement actually serves: a restart is only done when the
		// socket answers again.
		const status = await call<StatusResult>(socketPath, "status");
		expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
	}, 90_000);

	test("daemon down → exit 3, no daemon started", async () => {
		const agentDir = await tempAgentDir();
		const pidPath = join(agentDir, "oh-my-agent", "daemon.pid");

		// Restart is stop-then-launch, and the stop half has nothing to reach.
		// Starting one anyway would make `restart` a second spelling of
		// `daemon`, which is not what it was asked to be.
		const result = await runCapture(["daemon", "restart"], { agentDir });
		expect(result.code).toBe(3);
		expect(result.io.stdout).toBe("");
		expect(result.io.stderr).toContain(
			"oh-my-agent daemon not running — start it with `omp-agent daemon`.",
		);
		expect(existsSync(pidPath)).toBe(false);
	});
});

describe("omp-agent CLI — logs source selection", () => {
	test("`logs daemon` tails the daemon's own stderr log", async () => {
		const agentDir = await tempAgentDir();
		const { socketPath } = await spawnDaemon(agentDir);

		// The daemon logs its console URL to stderr at boot, so a live daemon
		// always has at least that line to show.
		const result = await runCapture(["logs", "daemon"], { agentDir });
		expect(result.code).toBe(0);
		expect(result.io.stderr).toBe("");
		expect(result.io.stdout).toContain("console:");

		// And it is the daemon log, not a worker's: no peer named "daemon"
		// exists, so a `logs_tail` that ignored the source would have failed.
		const tailed = await call<LogsTailResult>(socketPath, "logs_tail", {
			name: "daemon",
			source: "daemon",
		});
		expect(tailed.name).toBe("daemon");
		expect(tailed.lines.join("\n")).toContain("console:");
	}, 60_000);

	test("the daemon log accumulates stderr across restarts", async () => {
		const agentDir = await tempAgentDir();
		await spawnDaemon(agentDir);
		const logPath = join(agentDir, "oh-my-agent", "daemon.log");

		const firstBoot = await Bun.file(logPath).text();
		expect(firstBoot).toContain("console:");

		const restarted = await runCapture(["daemon", "restart"], { agentDir });
		expect(restarted.code).toBe(0);
		const pid = Number(
			(
				await Bun.file(join(agentDir, "oh-my-agent", "daemon.pid")).text()
			).trim(),
		);
		cleanups.push(async () => {
			if (!alive(pid)) return;
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Exited between the check and the signal.
			}
		});

		// Appended, never truncated: the first boot's output is what a restart
		// loop would otherwise destroy exactly when it is needed.
		const afterRestart = await Bun.file(logPath).text();
		expect(afterRestart.startsWith(firstBoot)).toBe(true);
		expect(afterRestart.length).toBeGreaterThan(firstBoot.length);
	}, 90_000);

	test("the daemon log is 0600, like the token it records", async () => {
		const agentDir = await tempAgentDir();
		await spawnDaemon(agentDir);
		const stateDir = join(agentDir, "oh-my-agent");
		const logPath = join(stateDir, "daemon.log");

		// The daemon announces its console URL to stderr at boot, and that URL
		// carries the operator token — so this file is a credential store, and
		// must be no more readable than the token file beside it.
		expect(await Bun.file(logPath).text()).toContain("?token=");
		expect((await stat(logPath)).mode & 0o777).toBe(0o600);
		expect((await stat(join(stateDir, "console-token"))).mode & 0o777).toBe(
			0o600,
		);
	}, 60_000);

	test("a world-readable log left by an earlier boot is tightened", async () => {
		const agentDir = await tempAgentDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await mkdir(stateDir, { recursive: true });
		const logPath = join(stateDir, "daemon.log");

		// Crash debris from a boot that predates the 0600 create mode. `open`'s
		// mode argument never touches an existing file, so this is the case only
		// the chmod covers — and the case where a token is already on disk.
		await writeFile(logPath, "console: http://127.0.0.1:9999/?token=stale\n", {
			encoding: "utf8",
			mode: 0o644,
		});
		await chmod(logPath, 0o644);
		expect((await stat(logPath)).mode & 0o777).toBe(0o644);

		await spawnDaemon(agentDir);

		expect((await stat(logPath)).mode & 0o777).toBe(0o600);
		// Tightened, never truncated: the old boot's output is still evidence.
		expect(await Bun.file(logPath).text()).toContain("?token=stale");
	}, 60_000);

	test("`logs <peer>` still defaults to worker stderr", async () => {
		const agentDir = await tempAgentDir();
		await writePeer(agentDir, "reviewer");
		const { handle } = await bootWith(agentDir);

		const result = await runCapture(["logs", "reviewer"], { agentDir });
		expect(result.code).toBe(0);
		expect(result.io.stderr).toBe("");

		// The default is worker stderr, and an unknown peer is still refused
		// there — proving `source` defaulted rather than silently widening.
		const tailed = await call<LogsTailResult>(handle.socketPath, "logs_tail", {
			name: "reviewer",
		});
		expect(tailed.name).toBe("reviewer");

		const ghost = await runCapture(["logs", "ghost"], { agentDir });
		expect(ghost.code).toBe(4);
		expect(ghost.io.stderr).toContain("Unknown agent: ghost");
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
