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
 * socket spawns the plugin-local entry with Bun (not process.execPath, which
 * is the OMP executable in binary installs). PI_CODING_AGENT_DIR points at
 * the active profile; the optional omp-agent shell shim is never required.
 * A spawn that exits non-zero is still success if a later probe works
 * (pidfile already-running race). Probe/spawn surprises return
 * `{ state: "failed" }` rather than throwing into the TUI, carrying the
 * launcher's own first stderr line as `reason` so the widget can say why
 * instead of repeating the generic daemon-down sentence. An auth fault is
 * not absence and never triggers a spawn; it travels out to the caller.
 */

import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { DaemonClient } from "./commands";
import { DaemonUnavailableError } from "./commands";

/** How long a session start may spend waiting for a daemon spawn. */
const SPAWN_DEADLINE_MS = 15_000;

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
	/** Injectable so a test does not wait out `SPAWN_DEADLINE_MS` in real time. */
	deadlineMs: number;
}

/** What `ensureDaemon` concluded, and the daemon's own words when it failed. */
export interface EnsureDaemonResult {
	state: "up" | "failed";
	/** The launcher's first stderr line, when a spawn failed with one. */
	reason?: string;
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
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return {
		exitCode: exitCode ?? 1,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
	};
}

function isUnavailable(error: unknown): boolean {
	return error instanceof DaemonUnavailableError;
}

/** The launcher's own first line of complaint, when it wrote one. */
function firstLine(result: SpawnLauncherResult): string | undefined {
	const text = result.stderr.length > 0 ? result.stderr : result.stdout;
	const line = text.split("\n", 1)[0]?.trim();
	return line !== undefined && line.length > 0 ? line : undefined;
}

/**
 * Return `"up"` once `status` succeeds, starting the plugin-local daemon if
 * the socket is absent. `"failed"` means the socket is still down after the
 * spawn attempt; callers paint the widget and do not throw.
 *
 * Only `DaemonUnavailableError` justifies a spawn. A `DaemonAuthError`
 * travels out to the caller untouched: the socket answered, so starting a
 * second daemon would do nothing except die on the pidfile the live one
 * holds — which is exactly what the operator's log filled up with.
 */
export async function ensureDaemon(
	client: DaemonClient,
	deps: Partial<EnsureDaemonDeps> = {},
): Promise<EnsureDaemonResult> {
	const probe = deps.probe ?? (() => defaultProbe(client));
	const spawn = deps.spawn ?? defaultSpawn;
	const agentDir = deps.agentDir ?? getAgentDir;
	const deadlineMs = deps.deadlineMs ?? SPAWN_DEADLINE_MS;

	try {
		await probe();
		return { state: "up" };
	} catch (error) {
		if (!isUnavailable(error)) throw error;
	}

	let reason: string | undefined;
	try {
		// Bounded: the launcher waits on the detached child's readiness line,
		// and this call sits inside OMP's `session_start`. A daemon that hangs
		// on a wedged broker would otherwise hang the TUI opening the session.
		const result = await Promise.race([
			spawn({
				cmd: [Bun.which("bun") ?? "bun", DAEMON_MAIN_PATH, "daemon"],
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir() },
			}),
			new Promise<SpawnLauncherResult>((resolve) => {
				const timer = setTimeout(
					() =>
						resolve({
							exitCode: 1,
							stdout: "",
							stderr: `daemon start did not finish within ${deadlineMs}ms`,
						}),
					deadlineMs,
				);
				timer.unref?.();
			}),
		]);
		if (result.exitCode !== 0) reason = firstLine(result);
	} catch (error) {
		// A spawn that throws is the same operator-facing condition as a
		// non-zero exit: retry the probe in case another session won the
		// pidfile race and the socket is live anyway.
		reason = error instanceof Error ? error.message : String(error);
	}

	try {
		await probe();
		return { state: "up" };
	} catch (error) {
		if (!isUnavailable(error)) throw error;
		// The launcher's reason, not a generic sentence: "already running for
		// this profile" and "bun not found" send the operator to different
		// places, and only the daemon knows which one happened.
		return { state: "failed", ...(reason === undefined ? {} : { reason }) };
	}
}
