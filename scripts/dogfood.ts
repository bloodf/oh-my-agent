#!/usr/bin/env bun
/**
 * Purpose: Runs docs/dogfooding.md §4 through the public `omp-agent --json` CLI.
 * Public API: runDogfood(options), DogfoodOptions, DogfoodReport.
 * Upstream deps: Bun subprocesses, DOGFOOD_* environment, daemon pidfile, host `ps`.
 * Downstream consumers: direct script invocation and tests/dogfood.test.ts.
 * Failure modes: refuses unsafe account/bump inputs before CLI use, stops on the
 * first failed/timed-out check, and always cleans workers, schedules, and daemon.
 * Performance: sequential CLI calls; bounded per call and poll deadline.
 */
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

interface AgentRow {
	name: string;
	state: "running" | "parked" | "stopped";
	parent?: string;
	children?: string[];
}

interface ScheduleRow {
	id: string;
	cron: string | null;
	action: string;
	nextFireAt: number | null;
	enabled: boolean;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	json?: unknown;
	elapsedMs: number;
}

export interface DogfoodOptions {
	account: string;
	parent: string;
	child: string;
	parentDefinition: string;
	childDefinition: string;
	editDocument: string;
	scheduleIndex: number;
	bumpUsd: number;
	accountAllowlist: readonly string[];
	maxBumpUsd: number;
	room: string;
	injectText: string;
	sessionId: string;
	cwd?: string;
	logPath?: string;
	command?: string[];
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	pollIntervalMs?: number;
	rssSampler?: (signal: AbortSignal) => Promise<number>;
}

export interface DogfoodReport {
	logPath: string;
	commands: number;
	spawnReadyMs: Record<string, number>;
	maxConcurrentAgents: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const TERMINATION_GRACE_MS = 100;
const TOKEN_REDACTIONS: Array<[RegExp, string]> = [
	[/([?&]token=)[^&\s"'\\]+/gi, "$1<redacted>"],
	[/(Authorization:\s*Bearer\s+)[^\s"'\\]+/gi, "$1<redacted>"],
	[/(X-Operator-Token:\s*)[^\s"'\\]+/gi, "$1<redacted>"],
	[/("[^"\\]*token[^"\\]*"\s*:\s*")[^"\\]*(")/gi, "$1<redacted>$2"],
];

function redact(value: string): string {
	return TOKEN_REDACTIONS.reduce(
		(redacted, [pattern, replacement]) =>
			redacted.replace(pattern, replacement),
		value,
	);
}

function requireObject(
	value: unknown,
	message: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}

function shellCommand(command: string[]): string {
	return command.map((part) => JSON.stringify(part)).join(" ");
}

function waitForPoll(intervalMs: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, intervalMs);
	return promise;
}

function terminateAfterGrace(child: Bun.Subprocess): void {
	try {
		child.kill("SIGTERM");
	} catch {}
	child.unref();
	const killTimer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {}
	}, TERMINATION_GRACE_MS);
	void child.exited
		.finally(() => clearTimeout(killTimer))
		.catch(() => undefined);
}

class CommandDeadlineError extends Error {}

async function collectCommand(
	child: Bun.Subprocess<"ignore", "pipe", "pipe">,
	timeoutMs: number,
): Promise<[number, string, string]> {
	const readers = Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	void readers.catch(() => undefined);
	const { promise: deadline, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		terminateAfterGrace(child);
		reject(new CommandDeadlineError(`timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	try {
		return await Promise.race([readers, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function defaultRssSampler(
	cwd: string,
	env: Record<string, string | undefined>,
	signal: AbortSignal,
): Promise<number> {
	const agentDir = env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	if (!agentDir)
		throw new Error("PI_CODING_AGENT_DIR is required to sample daemon RSS");
	const pid = Number(
		(
			await readFile(join(agentDir, "oh-my-agent", "daemon.pid"), "utf8")
		).trim(),
	);
	if (!Number.isInteger(pid) || pid <= 0)
		throw new Error("daemon pidfile contains no valid pid");
	const child = Bun.spawn({
		cmd: ["ps", "-o", "rss=", "-p", String(pid)],
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
		signal,
		killSignal: "SIGTERM",
	});
	const abort = () => terminateAfterGrace(child);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const rssKb = Number(stdout.trim());
		if (code !== 0 || !Number.isFinite(rssKb)) {
			throw new Error(
				`daemon RSS sample failed (exit ${code}): ${stderr.trim()}`,
			);
		}
		return rssKb;
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export async function runDogfood(
	options: DogfoodOptions,
): Promise<DogfoodReport> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const command = options.command ?? ["omp-agent"];
	const env = { ...process.env, ...options.env };
	const scheduleId = `${options.parent}:schedule:${options.scheduleIndex}`;
	if (command.length === 0) throw new Error("command must not be empty");
	if (options.accountAllowlist.length === 0)
		throw new Error("DOGFOOD_ACCOUNT_ALLOWLIST must not be empty");
	if (
		options.accountAllowlist.some(
			(account) => typeof account !== "string" || account.trim().length === 0,
		)
	) {
		throw new Error("DOGFOOD_ACCOUNT_ALLOWLIST contains an empty account");
	}
	if (options.account.trim().length === 0)
		throw new Error("DOGFOOD_ACCOUNT must not be empty");
	if (!options.accountAllowlist.includes(options.account)) {
		throw new Error(
			`DOGFOOD_ACCOUNT ${JSON.stringify(options.account)} is not allowlisted`,
		);
	}
	if (!Number.isFinite(options.maxBumpUsd) || options.maxBumpUsd < 0)
		throw new Error(
			"DOGFOOD_MAX_BUMP_USD must be a finite non-negative number",
		);
	if (!Number.isFinite(options.bumpUsd) || options.bumpUsd < 0)
		throw new Error("DOGFOOD_BUMP_USD must be a finite non-negative number");
	if (options.bumpUsd > options.maxBumpUsd) {
		throw new Error(
			`DOGFOOD_BUMP_USD ${options.bumpUsd} exceeds DOGFOOD_MAX_BUMP_USD ${options.maxBumpUsd}`,
		);
	}
	if (!Number.isInteger(options.scheduleIndex) || options.scheduleIndex < 0) {
		throw new Error("DOGFOOD_SCHEDULE_INDEX must be a non-negative integer");
	}
	if (!options.room.startsWith("#") && !options.room.startsWith("@")) {
		throw new Error("DOGFOOD_ROOM must start with # or @");
	}

	const edit = requireObject(
		JSON.parse(await readFile(options.editDocument, "utf8")),
		"DOGFOOD_EDIT_DOC must contain a JSON object",
	);
	const schedules = edit.schedules;
	if (!Array.isArray(schedules))
		throw new Error("DOGFOOD_EDIT_DOC.schedules must be an array");
	const authoredSchedule = requireObject(
		schedules[options.scheduleIndex],
		`DOGFOOD_EDIT_DOC.schedules[${options.scheduleIndex}] must be an object`,
	);
	const authoredKeys = Object.keys(authoredSchedule).sort();
	if (
		!authoredKeys.every((key) => ["cron", "prompt", "room"].includes(key)) ||
		typeof authoredSchedule.cron !== "string" ||
		authoredSchedule.cron.length === 0 ||
		typeof authoredSchedule.prompt !== "string" ||
		authoredSchedule.prompt.length === 0 ||
		(authoredSchedule.room !== undefined &&
			(typeof authoredSchedule.room !== "string" ||
				(!authoredSchedule.room.startsWith("#") &&
					!authoredSchedule.room.startsWith("@"))))
	) {
		throw new Error(
			"selected authored schedule must contain only cron, prompt, and optional #/@ room",
		);
	}

	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const configuredLog =
		options.logPath ??
		join(".dogfood", `${options.sessionId}-${timestamp}.log`);
	const logPath = resolve(cwd, configuredLog);
	const relativeLog = relative(cwd, logPath);
	if (
		relativeLog === "" ||
		relativeLog.startsWith("..") ||
		relativeLog.split(/[\\/]/)[0] !== ".dogfood"
	) {
		throw new Error("dogfood log must stay under .dogfood/");
	}
	await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
	const log = await open(logPath, "w", 0o600);
	await chmod(logPath, 0o600);

	let commandCount = 0;
	let currentStep = "preflight";
	const spawnReadyMs: Record<string, number> = {};
	let report: DogfoodReport | undefined;
	let maxConcurrentAgents = 0;
	const spawnedAgents = new Set<string>();
	const armedSchedules = new Set<string>();
	let primaryFailure: unknown;
	const sampleRss =
		options.rssSampler ??
		((signal: AbortSignal) => defaultRssSampler(cwd, env, signal));

	const writeLog = async (entry: Record<string, unknown>): Promise<void> => {
		await log.write(
			`${redact(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }))}\n`,
		);
	};

	let lastCommand: string | undefined;
	let lastCommandElapsedMs: number | undefined;
	const run = async (
		args: string[],
		settings: { allowErrorFrame?: boolean } = {},
	): Promise<CommandResult> => {
		const fullCommand = [...command, "--json", ...args];
		const renderedCommand = shellCommand(fullCommand);
		const started = performance.now();
		lastCommand = renderedCommand;
		lastCommandElapsedMs = undefined;
		let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			child = Bun.spawn({
				cmd: fullCommand,
				cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			const elapsedMs = Math.round(performance.now() - started);
			lastCommandElapsedMs = elapsedMs;
			commandCount += 1;
			const message = error instanceof Error ? error.message : String(error);
			await writeLog({
				step: currentStep,
				type: "command",
				elapsedMs,
				command: renderedCommand,
				argv: fullCommand,
				status: "spawn-error",
				result: message,
			});
			throw new Error(`failed to spawn ${renderedCommand}: ${message}`);
		}

		let code: number;
		let stdout: string;
		let stderr: string;
		try {
			[code, stdout, stderr] = await collectCommand(child, timeoutMs);
		} catch (error) {
			const elapsedMs = Math.round(performance.now() - started);
			lastCommandElapsedMs = elapsedMs;
			commandCount += 1;
			const message = error instanceof Error ? error.message : String(error);
			await writeLog({
				step: currentStep,
				type: "command",
				elapsedMs,
				command: renderedCommand,
				argv: fullCommand,
				status: error instanceof CommandDeadlineError ? "timeout" : "failure",
				result: message,
			});
			throw error;
		}
		const elapsedMs = Math.round(performance.now() - started);
		lastCommandElapsedMs = elapsedMs;
		commandCount += 1;
		let json: unknown;
		let parseError: string | undefined;
		try {
			json = JSON.parse(stdout);
		} catch (error) {
			parseError = error instanceof Error ? error.message : String(error);
		}
		await writeLog({
			step: currentStep,
			type: "command",
			elapsedMs,
			command: renderedCommand,
			argv: fullCommand,
			status: code === 0 ? "success" : "failure",
			exitCode: code,
			result: json ?? { stdout, stderr },
		});
		if (code !== 0)
			throw new Error(`exit ${code}: ${stderr.trim() || stdout.trim()}`);
		if (parseError) throw new Error(`invalid JSON output: ${parseError}`);
		const object = requireObject(json, "JSON result must be an object");
		if ("error" in object && settings.allowErrorFrame !== true)
			throw new Error(`error frame: ${JSON.stringify(object.error)}`);
		return { code, stdout, stderr, json, elapsedMs };
	};

	const agentsFrom = (result: CommandResult): AgentRow[] => {
		const agents = requireObject(
			result.json,
			"agents result must be an object",
		).agents;
		if (!Array.isArray(agents))
			throw new Error("agents result must contain agents[]");
		return agents as AgentRow[];
	};
	const schedulesFrom = (result: CommandResult): ScheduleRow[] => {
		const rows = requireObject(
			result.json,
			"schedule result must be an object",
		).schedules;
		if (!Array.isArray(rows))
			throw new Error("schedule result must contain schedules[]");
		return rows as ScheduleRow[];
	};
	const pollAgents = async (
		predicate: (agents: AgentRow[]) => boolean,
		description: string,
	): Promise<AgentRow[]> => {
		const deadline = performance.now() + timeoutMs;
		let last = "no result";
		while (performance.now() < deadline) {
			const result = await run(["agents"], { allowErrorFrame: true });
			const frame = requireObject(result.json, "poll result must be an object");
			if ("error" in frame) {
				last = `error frame: ${JSON.stringify(frame.error)}`;
			} else {
				const agents = agentsFrom(result);
				last = JSON.stringify(agents);
				if (predicate(agents)) return agents;
			}
			await waitForPoll(
				Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())),
			);
		}
		throw new Error(
			`poll timed out waiting for ${description}; last result: ${last}`,
		);
	};
	const phaseRss = async (phase: number): Promise<void> => {
		const controller = new AbortController();
		const sample = Promise.resolve().then(() => sampleRss(controller.signal));
		void sample.catch(() => undefined);
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`daemon RSS sample timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		try {
			const daemonRssKb = await Promise.race([sample, timeout]);
			await writeLog({
				step: currentStep,
				type: "daemon-rss",
				phase,
				daemonRssKb,
			});
		} finally {
			clearTimeout(timer);
		}
	};
	const step = async (
		number: number,
		name: string,
		action: () => Promise<void>,
	): Promise<void> => {
		currentStep = `Step ${number}: ${name}`;
		const started = performance.now();
		lastCommand = undefined;
		lastCommandElapsedMs = undefined;
		try {
			if (number === 18) await phaseRss(number);
			await action();
			if (number !== 18) await phaseRss(number);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await writeLog({
				step: currentStep,
				type: "step-failure",
				status: "failure",
				elapsedMs: Math.round(performance.now() - started),
				...(lastCommand ? { command: lastCommand } : {}),
				...(lastCommandElapsedMs === undefined
					? {}
					: { commandElapsedMs: lastCommandElapsedMs }),
				result: message,
			});
			throw new Error(`${currentStep} failed: ${message}`);
		}
	};
	const requireSchedule = (rows: ScheduleRow[]): ScheduleRow => {
		const schedule = rows.find((row) => row.id === scheduleId);
		if (!schedule) throw new Error(`runtime schedule ${scheduleId} not found`);
		if (
			schedule.cron !== authoredSchedule.cron ||
			schedule.action !== authoredSchedule.prompt
		) {
			throw new Error(
				`runtime schedule ${scheduleId} differs from authored schedule`,
			);
		}
		if (!("nextFireAt" in schedule))
			throw new Error(`runtime schedule ${scheduleId} lacks nextFireAt`);
		return schedule;
	};

	try {
		await step(1, "Confirm daemon status", async () => {
			const status = requireObject(
				(await run(["status"])).json,
				"status result must be an object",
			);
			if (typeof status.protocolVersion !== "number")
				throw new Error("daemon status lacks protocolVersion");
		});
		await step(2, "Confirm clean baseline state", async () => {
			if (agentsFrom(await run(["agents"])).length !== 0)
				throw new Error("baseline agents[] is not empty");
			if (schedulesFrom(await run(["schedule"])).length !== 0)
				throw new Error("baseline schedules[] is not empty");
		});
		await step(3, "Create and show parent", async () => {
			await run(["agent", "create", options.parent, options.parentDefinition]);
			await run(["agent", "show", options.parent]);
		});
		await step(4, "Edit and re-read parent", async () => {
			const edited = requireObject(
				(await run(["agent", "edit", options.parent, options.editDocument]))
					.json,
				"edit result must be an object",
			);
			if (typeof edited.rebuildRequired !== "boolean")
				throw new Error("agent edit lacks rebuildRequired");
			const shown = requireObject(
				(await run(["agent", "show", options.parent])).json,
				"show result must be an object",
			);
			const definition = requireObject(
				shown.definition,
				"agent show lacks definition",
			);
			const shownSchedules = definition.schedules;
			if (
				!Array.isArray(shownSchedules) ||
				JSON.stringify(shownSchedules[options.scheduleIndex]) !==
					JSON.stringify(authoredSchedule)
			) {
				throw new Error(
					"agent show schedule differs from approved authored entry",
				);
			}
		});
		await step(5, "Create and show child", async () => {
			await run(["agent", "create", options.child, options.childDefinition]);
			await run(["agent", "show", options.child]);
		});
		await step(6, "Spawn parent", async () => {
			const started = performance.now();
			spawnedAgents.add(options.parent);
			await run(["spawn", options.parent]);
			await pollAgents(
				(agents) =>
					agents.some(
						(agent) =>
							agent.name === options.parent && agent.state === "running",
					),
				`${options.parent} running`,
			);
			spawnReadyMs[options.parent] = Math.round(performance.now() - started);
			await writeLog({
				step: currentStep,
				type: "spawn-ready",
				agent: options.parent,
				latencyMs: spawnReadyMs[options.parent],
			});
		});
		await step(
			7,
			"Spawn child under parent and confirm hierarchy",
			async () => {
				const started = performance.now();
				spawnedAgents.add(options.child);
				await run(["spawn", options.child, "--parent", options.parent]);
				const agents = await pollAgents((rows) => {
					const parent = rows.find((agent) => agent.name === options.parent);
					const child = rows.find((agent) => agent.name === options.child);
					return (
						parent?.state === "running" &&
						parent.children?.includes(options.child) === true &&
						child?.state === "running" &&
						child.parent === options.parent
					);
				}, "parent/child hierarchy running");
				spawnReadyMs[options.child] = Math.round(performance.now() - started);
				maxConcurrentAgents = agents.filter(
					(agent) => agent.state === "running",
				).length;
				await writeLog({
					step: currentStep,
					type: "spawn-ready",
					agent: options.child,
					latencyMs: spawnReadyMs[options.child],
				});
				await writeLog({
					step: currentStep,
					type: "concurrent-agents",
					count: maxConcurrentAgents,
					agents: agents
						.filter((agent) => agent.state === "running")
						.map((agent) => agent.name),
				});
			},
		);
		await step(8, "List, read, post, and re-read room", async () => {
			await run(["rooms"]);
			await run(["rooms", "read", options.room]);
			await run([
				"rooms",
				"post",
				options.room,
				`dogfood session ${options.sessionId}`,
			]);
			const read = requireObject(
				(await run(["rooms", "read", options.room])).json,
				"rooms read result must be an object",
			);
			if (
				!Array.isArray(read.messages) ||
				!read.messages.some(
					(message) =>
						requireObject(message, "room message must be an object").body ===
						`dogfood session ${options.sessionId}`,
				)
			) {
				throw new Error("posted dogfood session message not found");
			}
		});
		await step(9, "List schedules before restart", async () => {
			await run(["schedule"]);
		});
		await step(10, "Read worker and daemon logs", async () => {
			await run(["logs", options.parent, "100"]);
			await run(["logs", options.child, "100"]);
			await run(["logs", "daemon", "100"]);
		});
		await step(11, "Inject approved steering text", async () => {
			await run(["inject", options.child, options.injectText]);
		});
		await step(12, "Apply approved account bump", async () => {
			if (options.account.trim().length === 0)
				throw new Error("approved account is no longer non-empty");
			if (!Number.isFinite(options.bumpUsd))
				throw new Error("approved bump is no longer finite");
			await run(["bump", options.account, String(options.bumpUsd)]);
		});
		await step(13, "Kill parent while retaining child", async () => {
			await run(["kill", options.parent, "--keep-children"]);
			await pollAgents((agents) => {
				const parent = agents.find((agent) => agent.name === options.parent);
				const child = agents.find((agent) => agent.name === options.child);
				return (
					parent?.state === "stopped" &&
					child?.state === "running" &&
					child.parent === undefined
				);
			}, "parent stopped and retained child reparented");
		});
		await step(14, "Kill retained child", async () => {
			await run(["kill", options.child]);
			await pollAgents(
				(agents) =>
					agents.find((agent) => agent.name === options.child)?.state ===
					"stopped",
				"retained child stopped",
			);
		});
		await step(15, "Recreate hierarchy", async () => {
			const parentStarted = performance.now();
			spawnedAgents.add(options.parent);
			await run(["spawn", options.parent]);
			await pollAgents(
				(agents) =>
					agents.find((agent) => agent.name === options.parent)?.state ===
					"running",
				`${options.parent} running again`,
			);
			const parentLatency = Math.round(performance.now() - parentStarted);
			const childStarted = performance.now();
			spawnedAgents.add(options.child);
			await run(["spawn", options.child, "--parent", options.parent]);
			const agents = await pollAgents(
				(rows) =>
					rows
						.find((agent) => agent.name === options.parent)
						?.children?.includes(options.child) === true &&
					rows.find((agent) => agent.name === options.child)?.parent ===
						options.parent,
				"recreated hierarchy",
			);
			const childLatency = Math.round(performance.now() - childStarted);
			maxConcurrentAgents = Math.max(
				maxConcurrentAgents,
				agents.filter((agent) => agent.state === "running").length,
			);
			await writeLog({
				step: currentStep,
				type: "spawn-ready",
				agent: options.parent,
				latencyMs: parentLatency,
			});
			await writeLog({
				step: currentStep,
				type: "spawn-ready",
				agent: options.child,
				latencyMs: childLatency,
			});
			await writeLog({
				step: currentStep,
				type: "concurrent-agents",
				count: agents.filter((agent) => agent.state === "running").length,
				agents: agents
					.filter((agent) => agent.state === "running")
					.map((agent) => agent.name),
			});
		});
		await step(16, "Exercise default cascade kill", async () => {
			await run(["kill", options.parent]);
			await pollAgents(
				(agents) =>
					!agents.some(
						(agent) =>
							(agent.name === options.parent || agent.name === options.child) &&
							agent.state === "running",
					),
				"parent and child stopped",
			);
		});
		await step(
			17,
			"Restart daemon and exercise schedule controls",
			async () => {
				await run(["daemon", "restart"]);
				await run(["status"]);
				const restartedSchedule = requireSchedule(
					schedulesFrom(await run(["schedule"])),
				);
				if (restartedSchedule.enabled !== true) {
					throw new Error(
						`runtime schedule ${scheduleId} is not enabled after restart`,
					);
				}
				armedSchedules.add(scheduleId);
				const enabled = requireObject(
					(await run(["schedule", scheduleId, "on"])).json,
					"schedule on result must be an object",
				);
				if (
					requireObject(enabled.schedule, "schedule on lacks schedule")
						.enabled !== true
				)
					throw new Error("schedule on did not enable schedule");
				if (!requireSchedule(schedulesFrom(await run(["schedule"]))).enabled)
					throw new Error("listed schedule is not enabled");
				const disabled = requireObject(
					(await run(["schedule", scheduleId, "off"])).json,
					"schedule off result must be an object",
				);
				if (
					requireObject(disabled.schedule, "schedule off lacks schedule")
						.enabled !== false
				)
					throw new Error("schedule off did not disable schedule");
				if (requireSchedule(schedulesFrom(await run(["schedule"]))).enabled) {
					throw new Error("listed schedule is not disabled");
				}
				armedSchedules.delete(scheduleId);
			},
		);
		await step(18, "Begin unconditional cleanup", async () => {});
		await log.sync();
		report = {
			logPath,
			commands: commandCount,
			spawnReadyMs,
			maxConcurrentAgents,
		};
	} catch (error) {
		primaryFailure = error;
	} finally {
		currentStep = "Cleanup";
		const cleanupErrors: string[] = [];
		const logCleanupFailure = async (message: string): Promise<void> => {
			cleanupErrors.push(message);
			try {
				await writeLog({
					step: currentStep,
					type: "cleanup-failure",
					result: message,
				});
			} catch {
				// Logging the failure itself failed; the message still surfaces
				// via cleanupErrors and the thrown primaryFailure below.
			}
		};
		const agentsToKill = [...spawnedAgents].reverse();
		for (const agent of agentsToKill) {
			try {
				await run(["kill", agent]);
			} catch (error) {
				await logCleanupFailure(
					`kill ${agent}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const schedule of armedSchedules) {
			try {
				await run(["schedule", schedule, "off"]);
			} catch (error) {
				await logCleanupFailure(
					`schedule ${schedule} off: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		try {
			await run(["daemon", "stop"]);
		} catch (error) {
			await logCleanupFailure(
				`daemon stop: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			await log.close();
		} catch (error) {
			await logCleanupFailure(
				`log close: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (primaryFailure === undefined && cleanupErrors.length > 0) {
			primaryFailure = new Error(
				`dogfood cleanup failed: ${cleanupErrors.join("; ")}`,
			);
		}
	}
	if (primaryFailure !== undefined) throw primaryFailure;
	if (!report) throw new Error("dogfood completed without a report");
	report.commands = commandCount;
	return report;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}

if (import.meta.main) {
	try {
		const scheduleIndex = Number(requiredEnv("DOGFOOD_SCHEDULE_INDEX"));
		const bumpUsd = Number(requiredEnv("DOGFOOD_BUMP_USD"));
		const report = await runDogfood({
			account: requiredEnv("DOGFOOD_ACCOUNT"),
			accountAllowlist: requiredEnv("DOGFOOD_ACCOUNT_ALLOWLIST")
				.split(",")
				.map((account) => account.trim()),
			maxBumpUsd: Number(requiredEnv("DOGFOOD_MAX_BUMP_USD")),
			parent: requiredEnv("DOGFOOD_PARENT"),
			child: requiredEnv("DOGFOOD_CHILD"),
			parentDefinition: requiredEnv("DOGFOOD_PARENT_DEFINITION"),
			childDefinition: requiredEnv("DOGFOOD_CHILD_DEFINITION"),
			editDocument: requiredEnv("DOGFOOD_EDIT_DOC"),
			scheduleIndex,
			bumpUsd,
			room: requiredEnv("DOGFOOD_ROOM"),
			injectText: requiredEnv("DOGFOOD_INJECT_TEXT"),
			sessionId: requiredEnv("DOGFOOD_SESSION_ID"),
			...(process.env.DOGFOOD_SESSION_LOG
				? { logPath: process.env.DOGFOOD_SESSION_LOG }
				: {}),
			...(process.env.DOGFOOD_STEP_TIMEOUT_MS
				? { timeoutMs: Number(process.env.DOGFOOD_STEP_TIMEOUT_MS) }
				: {}),
		});
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
