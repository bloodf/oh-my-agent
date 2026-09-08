/**
 * Tests for session-start daemon auto-start. The mocked-seam cases below
 * never boot a real daemon; the compiled-host case spawns the production
 * launcher for real, `tests/daemon-main.test.ts` covers the RPC launcher.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type DaemonClient,
	DaemonUnavailableError,
} from "../src/extension/commands";
import {
	ensureDaemon,
	type SpawnLauncherRequest,
	type SpawnLauncherResult,
} from "../src/extension/ensure-daemon";
import { hermeticChildEnv } from "./fixtures/hermetic-env";
import { withTempAgentDir } from "./fixtures/temp-agent-dir";

const unusedClient: DaemonClient = {
	call: async () => {
		throw new Error("default probe must not run when deps.probe is set");
	},
};

function down(): never {
	throw new DaemonUnavailableError();
}

async function waitForExit(pid: number, deadlineMs = 5_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${pid} did not exit within ${deadlineMs}ms`);
}

async function stopTestDaemon(agentDir: string): Promise<void> {
	let pid: number;
	try {
		pid = Number(
			(
				await Bun.file(join(agentDir, "oh-my-agent", "daemon.pid")).text()
			).trim(),
		);
	} catch {
		return;
	}
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	try {
		await waitForExit(pid);
		return;
	} catch {
		// Still alive past the graceful deadline: escalate. A second failure
		// here is a real leak and must fail the test, not vanish.
	}
	process.kill(pid, "SIGKILL");
	await waitForExit(pid);
}

async function runCompiledHostProbe(
	agentDir: string,
	home: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn({
		cmd: [
			Bun.which("bun") ?? "bun",
			"-e",
			`const { join } = await import("node:path");
const { writeSync } = await import("node:fs");
const { ensureDaemon } = await import(process.env.ENSURE_DAEMON_MODULE);
const { createDaemonClient } = await import(process.env.DAEMON_WIDGET_MODULE);
Object.defineProperty(process, "execPath", { value: "/nonexistent/compiled-omp", configurable: true });
const socket = join(process.env.PI_CODING_AGENT_DIR, "oh-my-agent", "daemon.sock");
const client = createDaemonClient(socket);
const ensured = await ensureDaemon(client);
const { protocolVersion } = await client.call("status", {});
writeSync(1, JSON.stringify({ ensured, protocolVersion }) + "\\n");
process.exit(0);`,
		],
		env: hermeticChildEnv({
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			OMA_CONSOLE: "0",
			PI_CODING_AGENT_DIR: agentDir,
			OMP_AUTH_BROKER_URL: "",
			OMP_AUTH_BROKER_TOKEN: "",
			ENSURE_DAEMON_MODULE: join(
				import.meta.dir,
				"..",
				"src",
				"extension",
				"ensure-daemon.ts",
			),
			DAEMON_WIDGET_MODULE: join(
				import.meta.dir,
				"..",
				"src",
				"extension",
				"widget.ts",
			),
		}),
		cwd: agentDir,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 25_000,
		killSignal: "SIGKILL",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return {
		exitCode,
		stdout,
		stderr: stderr
			.replaceAll(agentDir, "<agent-dir>")
			.replaceAll(home, "<home>"),
	};
}

describe("ensureDaemon", () => {
	test("no-ops when status already succeeds", async () => {
		const spawned: SpawnLauncherRequest[] = [];
		const result = await ensureDaemon(unusedClient, {
			probe: async () => {},
			spawn: async (request) => {
				spawned.push(request);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			agentDir: () => "/tmp/oma-agent",
		});
		expect(result).toBe("up");
		expect(spawned).toEqual([]);
	});

	test("spawns the plugin-local daemon when the socket is down", async () => {
		let up = false;
		const spawned: SpawnLauncherRequest[] = [];
		const result = await ensureDaemon(unusedClient, {
			probe: async () => {
				if (!up) down();
			},
			spawn: async (request) => {
				spawned.push(request);
				up = true;
				return { exitCode: 0, stdout: "/tmp/daemon.sock", stderr: "" };
			},
			agentDir: () => "/tmp/oma-agent",
		});
		expect(result).toBe("up");
		expect(spawned).toHaveLength(1);
	});

	test("treats an already-running launcher refusal as up after a successful probe", async () => {
		let attempts = 0;
		const result = await ensureDaemon(unusedClient, {
			probe: async () => {
				attempts += 1;
				if (attempts === 1) down();
			},
			spawn: async () =>
				({
					exitCode: 1,
					stdout: "",
					stderr:
						"oh-my-agent daemon is already running for this profile (pid 9, /tmp/daemon.pid)",
				}) satisfies SpawnLauncherResult,
			agentDir: () => "/tmp/oma-agent",
		});
		expect(result).toBe("up");
		expect(attempts).toBe(2);
	});

	test("returns failed when spawn and the follow-up probe both miss", async () => {
		const result = await ensureDaemon(unusedClient, {
			probe: async () => {
				down();
			},
			spawn: async () => ({
				exitCode: 1,
				stdout: "",
				stderr: "boom",
			}),
			agentDir: () => "/tmp/oma-agent",
		});
		expect(result).toBe("failed");
	});

	test("returns failed when spawn throws and the socket stays down", async () => {
		const result = await ensureDaemon(unusedClient, {
			probe: async () => {
				down();
			},
			spawn: async () => {
				throw new Error("exec failed");
			},
			agentDir: () => "/tmp/oma-agent",
		});
		expect(result).toBe("failed");
	});

	test("propagates a non-unavailable probe error instead of spawning", async () => {
		const spawned: SpawnLauncherRequest[] = [];
		await expect(
			ensureDaemon(unusedClient, {
				probe: async () => {
					throw new Error("auth refused");
				},
				spawn: async (request) => {
					spawned.push(request);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				agentDir: () => "/tmp/oma-agent",
			}),
		).rejects.toThrow("auth refused");
		expect(spawned).toEqual([]);
	});

	test("starts daemon from a compiled-host child runtime", async () => {
		await withTempAgentDir(async (agentDir) => {
			const home = join(agentDir, "home");
			await mkdir(join(home, ".config"), { recursive: true });
			try {
				const result = await runCompiledHostProbe(agentDir, home);
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.stderr).toBe("");
				expect(JSON.parse(result.stdout)).toEqual({
					ensured: "up",
					protocolVersion: 1,
				});
			} finally {
				await stopTestDaemon(agentDir);
			}
		});
	}, 40_000);
});
