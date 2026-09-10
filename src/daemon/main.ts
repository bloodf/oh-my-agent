#!/usr/bin/env bun
/** Validate startup arguments before loading the daemon or OMP SDK. */
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
	type DaemonStartOptions,
	parseDaemonStartArgs,
	USAGE,
	UsageError,
} from "./startup";

/** How long the launcher waits for the detached daemon's readiness line. */
const READINESS_TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
let start: DaemonStartOptions | undefined;
try {
	start = parseDaemonStartArgs(argv);
} catch (error) {
	if (!(error instanceof UsageError)) throw error;
	if (error.message) process.stderr.write(`${error.message}\n`);
	process.stderr.write(USAGE);
	process.exit(2);
}

// Deliberate lazy boundaries: neither rejected arguments nor the parent
// launcher should initialize daemon workers, model discovery, or providers.
if (start === undefined) {
	const { runCli } = await import("./cli");
	process.exit(
		await runCli(argv, { agentDir: process.env.PI_CODING_AGENT_DIR }),
	);
} else if (process.env.OMA_DETACHED === "1") {
	const { runDaemon } = await import("./runtime");
	await runDaemon(start.workerBackend);
} else {
	const { getAgentDir } = await import("@oh-my-pi/pi-utils");
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const stateDir = join(agentDir, "oh-my-agent");
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	// `mkdir`'s mode applies only to a directory it creates, and this one
	// usually already exists — from an older release, or from a profile copied
	// between machines. The credential files inside are 0600, but a
	// world-readable directory still leaks which daemons a machine runs.
	await chmod(stateDir, 0o700);
	const logPath = join(stateDir, "daemon.log");
	const log = await open(logPath, "a", 0o600);
	let child: Bun.Subprocess<"ignore", "pipe", number>;
	try {
		await chmod(logPath, 0o600);
		child = Bun.spawn({
			cmd: [Bun.which("bun") ?? "bun", import.meta.path, ...argv],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMA_DETACHED: "1" },
			stdio: ["ignore", "pipe", log.fd],
			detached: true,
		});
		child.unref();
	} finally {
		// After the spawn has taken the descriptor: closing it in a `finally`
		// that ran between constructing the child and its inheriting the fd is
		// undefined behavior, and this log is the only crash record a detached
		// daemon leaves.
		await log.close();
	}
	let readiness = "";
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	// A daemon wedged on a broker probe would otherwise hold this pipe open
	// forever — and this launcher runs inside the TUI's session start, so the
	// hang would be the whole editor, not just the daemon.
	const deadline = new Promise<"timeout">((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), READINESS_TIMEOUT_MS);
		timer.unref?.();
	});
	try {
		while (!readiness.includes("\n")) {
			const next = await Promise.race([reader.read(), deadline]);
			if (next === "timeout") break;
			const { done, value } = next;
			if (done) break;
			readiness += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	if (!readiness.includes("\n")) {
		process.stderr.write(
			"oh-my-agent daemon exited before readiness; inspect its daemon.log.\n",
		);
		process.exit(1);
	}
	const socket = join(stateDir, "daemon.sock");
	const consoleUrl = readiness.split("\n", 1)[0]?.trim() || null;
	process.stdout.write(
		start.json
			? `${JSON.stringify({ socket, consoleUrl, workerBackend: start.workerBackend })}\n`
			: `${socket}\n${consoleUrl === null ? "" : `${consoleUrl}\n`}`,
	);
	process.exit(0);
}
