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
	} finally {
		await log.close();
	}
	child.unref();
	let readiness = "";
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	try {
		while (!readiness.includes("\n")) {
			const { done, value } = await reader.read();
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
