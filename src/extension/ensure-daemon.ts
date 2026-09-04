/**
 * Purpose: Start the detached oh-my-agent daemon from the plugin tree when
 * the TUI session begins, so `omp install` then `omp` is enough. The spawn
 * is a handler action, never load-time work: OMP throws
 * `ExtensionRuntimeNotInitializedError` before session start.
 *
 * Public API: `ensureDaemon(client, deps?)`, `DAEMON_MAIN_PATH`.
 *
 * Upstream deps: `./commands` (`DaemonClient`, `DaemonUnavailableError`),
 * `@oh-my-pi/pi-utils` (`getAgentDir`).
 *
 * Downstream consumers: `./index` on `session_start`;
 * `tests/ensure-daemon.test.ts`.
 *
 * Failure modes: an already-up daemon is a no-op. A refused or missing
 * socket spawns `[process.execPath, DAEMON_MAIN_PATH, "daemon"]` with
 * `PI_CODING_AGENT_DIR` pointing at the active profile — the same launcher
 * `omp-agent daemon` and `daemon restart` use, so PATH is never required.
 * A spawn that exits non-zero is still success if a later probe works
 * (pidfile already-running race). Probe/spawn surprises return `"failed"`
 * rather than throwing into the TUI; the widget then paints the shared
 * daemon-down sentence.
 */

import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { DaemonClient } from "./commands";
import { DaemonUnavailableError } from "./commands";

/** Plugin-local daemon entry, resolved from this module, never from PATH. */
export const DAEMON_MAIN_PATH = join(
	import.meta.dir,
	"..",
	"daemon",
	"main.ts",
);

export interface SpawnLauncherRequest {
	cmd: string[];
	env: Record<string, string | undefined>;
}

export interface SpawnLauncherResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface EnsureDaemonDeps {
	probe: () => Promise<void>;
	spawn: (request: SpawnLauncherRequest) => Promise<SpawnLauncherResult>;
	agentDir: () => string;
}

async function defaultProbe(client: DaemonClient): Promise<void> {
	await client.call("status", {});
}

async function defaultSpawn(
	request: SpawnLauncherRequest,
): Promise<SpawnLauncherResult> {
	const child = Bun.spawn({
		cmd: request.cmd,
		env: request.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	const exitCode = await child.exited;
	return {
		exitCode: exitCode ?? 1,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
	};
}

function isUnavailable(error: unknown): boolean {
	return error instanceof DaemonUnavailableError;
}

/**
 * Return `"up"` once `status` succeeds, starting the plugin-local daemon if
 * the socket is absent. `"failed"` means the socket is still down after the
 * spawn attempt; callers paint the widget and do not throw.
 */
export async function ensureDaemon(
	client: DaemonClient,
	deps: Partial<EnsureDaemonDeps> = {},
): Promise<"up" | "failed"> {
	const probe = deps.probe ?? (() => defaultProbe(client));
	const spawn = deps.spawn ?? defaultSpawn;
	const agentDir = deps.agentDir ?? getAgentDir;

	try {
		await probe();
		return "up";
	} catch (error) {
		if (!isUnavailable(error)) throw error;
	}

	try {
		await spawn({
			cmd: [process.execPath, DAEMON_MAIN_PATH, "daemon"],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir() },
		});
	} catch {
		// A spawn that throws is the same operator-facing condition as a
		// non-zero exit: retry the probe in case another session won the
		// pidfile race and the socket is live anyway.
	}

	try {
		await probe();
		return "up";
	} catch (error) {
		if (!isUnavailable(error)) throw error;
		return "failed";
	}
}
