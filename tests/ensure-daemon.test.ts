/**
 * Tests for session-start daemon auto-start. The spawn is a seam so this
 * suite never boots a real daemon; `tests/daemon-main.test.ts` already
 * covers the launcher.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import {
	type DaemonClient,
	DaemonUnavailableError,
} from "../src/extension/commands";
import {
	DAEMON_MAIN_PATH,
	ensureDaemon,
	type SpawnLauncherRequest,
	type SpawnLauncherResult,
} from "../src/extension/ensure-daemon";

const unusedClient: DaemonClient = {
	call: async () => {
		throw new Error("default probe must not run when deps.probe is set");
	},
};

function down(): never {
	throw new DaemonUnavailableError();
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
		expect(spawned[0]?.cmd).toEqual([
			process.execPath,
			DAEMON_MAIN_PATH,
			"daemon",
		]);
		expect(spawned[0]?.env.PI_CODING_AGENT_DIR).toBe("/tmp/oma-agent");
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
});
