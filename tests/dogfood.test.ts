import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	watch,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DogfoodOptions, runDogfood } from "../scripts/dogfood";
import {
	type PeerDefinitionFields,
	renderPeerDefinition,
} from "../src/daemon/peer-store";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface AgentState {
	name: string;
	state: "running" | "starting" | "stopped";
	account: string;
	parent?: string;
	children?: string[];
	polls?: number;
}

interface FixtureState {
	definitions: Record<string, Record<string, unknown>>;
	agents: Record<string, AgentState>;
	messages: Array<Record<string, unknown>>;
	schedule?: { cron: string; prompt: string; room?: string };
	scheduleEnabled: boolean;
	restarted: boolean;
	stopped: boolean;
	methods: string[];
	ownedDaemonPid?: number;
}

interface Fixture {
	dir: string;
	state: FixtureState;
	options: DogfoodOptions;
	fastCommand: string[];
	stubStatePath: string;
	failMethod?: string;
	hangMethod?: string;
	cleanupFailMethod?: string;
	failMethodOccurrence?: number;
}

function rpcSuccess(id: number | string, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: number | string, message: string): Response {
	return Response.json({
		jsonrpc: "2.0",
		id,
		error: { code: -32603, message, data: { protocolVersion: 1 } },
	});
}
async function captureError(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected action to fail");
}

type CommandExpectation =
	| readonly string[]
	| { repeat: readonly string[]; min: number };

function assertExactCommands(
	actual: readonly (readonly string[])[],
	expected: readonly CommandExpectation[],
): void {
	let actualIndex = 0;
	for (const expectedCommand of expected) {
		if (!("repeat" in expectedCommand)) {
			expect(actual[actualIndex]).toEqual(expectedCommand);
			actualIndex += 1;
			continue;
		}
		let repeats = 0;
		while (
			JSON.stringify(actual[actualIndex]) ===
			JSON.stringify(expectedCommand.repeat)
		) {
			actualIndex += 1;
			repeats += 1;
		}
		expect(repeats).toBeGreaterThanOrEqual(expectedCommand.min);
	}
	expect(actualIndex).toBe(actual.length);
}

async function fixture(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "oma-dogfood-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const agentDir = join(dir, "agent");
	const stateDir = join(agentDir, "oh-my-agent");
	await mkdir(stateDir, { recursive: true });
	const token = "fixture-secret";
	await writeFile(join(stateDir, "console-token"), token, { mode: 0o600 });
	const socketPath = join(stateDir, "daemon.sock");
	const state: FixtureState = {
		definitions: {},
		agents: {},
		messages: [],
		scheduleEnabled: false,
		restarted: false,
		stopped: false,
		methods: [],
	};
	const harness: Fixture = {
		dir,
		state,
		fastCommand: [],
		stubStatePath: "",
		options: undefined as unknown as DogfoodOptions,
	};

	const server = Bun.serve({
		unix: socketPath,
		fetch: async (request) => {
			if (request.headers.get("Authorization") !== `Bearer ${token}`) {
				return rpcError(0, "Unauthorized");
			}
			const frame = (await request.json()) as {
				id: number | string;
				method: string;
				params: Record<string, unknown>;
			};
			state.methods.push(frame.method);
			// Real network latency is the fixture behavior under test; fake timers
			// cannot advance time inside independently spawned real CLI processes.
			await Bun.sleep(2);
			if (harness.failMethod === frame.method) {
				const occurrence = state.methods.filter(
					(method) => method === frame.method,
				).length;
				if (occurrence === (harness.failMethodOccurrence ?? 1)) {
					harness.failMethod = undefined;
					return rpcError(frame.id, "injected fixture error frame");
				}
			}
			if (harness.cleanupFailMethod === frame.method) {
				harness.cleanupFailMethod = undefined;
				return rpcError(frame.id, "injected cleanup error frame");
			}
			const params = frame.params ?? {};
			const agentRows = (): AgentState[] =>
				Object.values(state.agents).map((agent) => {
					if (agent.state === "starting") {
						agent.polls = (agent.polls ?? 0) + 1;
						if (agent.polls >= 2) agent.state = "running";
					}
					const { polls: _polls, ...row } = agent;
					return {
						...row,
						state: row.state === "starting" ? "parked" : row.state,
					} as AgentState;
				});
			const schedule = () => ({
				id: `parent:schedule:0`,
				cron: state.schedule?.cron ?? "0 9 * * *",
				action: state.schedule?.prompt ?? "morning",
				nextFireAt: Date.now() + 60_000,
				enabled: state.scheduleEnabled,
			});

			switch (frame.method) {
				case "status":
					return rpcSuccess(frame.id, {
						protocolVersion: 1,
						agents: agentRows(),
						uptimeMs: 10,
					});
				case "agent_status":
					return rpcSuccess(frame.id, { agents: agentRows() });
				case "agent_create": {
					const name = String(params.name);
					state.definitions[name] = { ...params, sha256: "a".repeat(64) };
					const definitionsDir = join(stateDir, "agents");
					await mkdir(definitionsDir, { recursive: true });
					await writeFile(
						join(definitionsDir, `${name}.md`),
						renderPeerDefinition(params as unknown as PeerDefinitionFields),
					);
					return rpcSuccess(frame.id, { name, created: true });
				}
				case "definition_get": {
					const name = String(params.name);
					return rpcSuccess(frame.id, {
						name,
						definition: state.definitions[name],
						filePath: join(agentDir, "oh-my-agent", "agents", `${name}.md`),
					});
				}
				case "definition_update": {
					const name = String(params.name);
					const changes = params.changes as Record<string, unknown>;
					state.definitions[name] = { ...state.definitions[name], ...changes };
					state.schedule = (
						changes.schedules as FixtureState["schedule"][]
					)?.[0];
					await writeFile(
						join(stateDir, "agents", `${name}.md`),
						renderPeerDefinition(
							state.definitions[name] as unknown as PeerDefinitionFields,
						),
					);
					return rpcSuccess(frame.id, { name, rebuildRequired: true });
				}
				case "agent_spawn": {
					const name = String(params.name);
					const parent =
						params.parent === undefined ? undefined : String(params.parent);
					state.agents[name] = {
						name,
						state: "starting",
						account: "stub-account",
						polls: 0,
						...(parent ? { parent } : {}),
					};
					if (parent) {
						const parentAgent = state.agents[parent];
						if (parentAgent)
							parentAgent.children = [
								...new Set([...(parentAgent.children ?? []), name]),
							];
					}
					return rpcSuccess(frame.id, { name, state: "running" });
				}
				case "rooms_list":
					return rpcSuccess(frame.id, {
						rooms: [{ id: "#reviews", kind: "channel", name: "reviews" }],
					});
				case "chat_read":
					return rpcSuccess(frame.id, { messages: state.messages });
				case "rooms_post": {
					const messageId = state.messages.length + 1;
					state.messages.push({
						id: messageId,
						room: params.room,
						author: "human",
						body: params.body,
						createdAt: Date.now(),
					});
					return rpcSuccess(frame.id, { messageId, createdAt: Date.now() });
				}
				case "schedules_list":
					return rpcSuccess(frame.id, {
						schedules: state.restarted ? [schedule()] : [],
					});
				case "schedules_arm":
					state.scheduleEnabled = Boolean(params.enabled);
					return rpcSuccess(frame.id, { schedule: schedule() });
				case "logs_tail":
					return rpcSuccess(frame.id, {
						name: params.name,
						lines: [
							"https://fixture.invalid/?token=fixture-secret",
							"Authorization: Bearer fixture-secret",
							"X-Operator-Token: fixture-secret",
						],
					});
				case "inject":
					return rpcSuccess(frame.id, { name: params.name, queued: true });
				case "bump":
					return rpcSuccess(frame.id, {
						account: params.account,
						budgetUsd: params.budgetUsd,
						resumed: [],
					});
				case "kill": {
					const name = String(params.name);
					const agent = state.agents[name];
					if (agent) {
						agent.state = "stopped";
						for (const childName of agent.children ?? []) {
							const child = state.agents[childName];
							if (!child) continue;
							if (params.keep_children === true) delete child.parent;
							else child.state = "stopped";
						}
						agent.children = [];
					}
					return rpcSuccess(frame.id, { name, state: "stopped" });
				}
				case "fixture_restart":
					state.restarted = true;
					state.scheduleEnabled = true;
					return rpcSuccess(frame.id, { restarted: true });
				case "fixture_stop":
					state.stopped = true;
					return rpcSuccess(frame.id, { stopping: true });
				case "daemon_stop": {
					const sleeper = Bun.spawn(
						[process.execPath, "-e", "setTimeout(() => {}, 1000)"],
						{ stdout: "ignore", stderr: "ignore" },
					);
					state.ownedDaemonPid = sleeper.pid;
					await writeFile(join(stateDir, "daemon.pid"), String(sleeper.pid));
					setTimeout(async () => {
						await rm(join(stateDir, "daemon.pid"), { force: true });
						sleeper.kill();
						await sleeper.exited;
						server.stop(false);
					}, 0);
					state.stopped = true;
					return rpcSuccess(frame.id, { stopping: true, pid: sleeper.pid });
				}
				default:
					return rpcError(
						frame.id,
						`unsupported fixture method: ${frame.method}`,
					);
			}
		},
	} as Bun.Serve.Options<undefined>);
	cleanups.push(async () => server.stop(true));

	const parentDefinition = join(dir, "parent.md");
	const childDefinition = join(dir, "child.md");
	const editDocument = join(dir, "edit.json");
	await writeFile(
		parentDefinition,
		'---\nname: "parent"\ndescription: "parent fixture"\nmodel: "openai/stub"\nspawns: ["child"]\n---\nParent.\n',
	);
	await writeFile(
		childDefinition,
		'---\nname: "child"\ndescription: "child fixture"\nmodel: "openai/stub"\nspawns: ["parent"]\n---\nChild.\n',
	);
	await writeFile(
		editDocument,
		JSON.stringify({
			schedules: [{ cron: "0 9 * * *", prompt: "morning", room: "#reviews" }],
		}),
	);
	const stubPath = join(dir, "omp-agent-stub.js");
	const stubStatePath = join(dir, "omp-agent-stub-state");
	await writeFile(
		stubPath,
		`const args = process.argv.slice(2);
if (args.shift() !== "--json") process.exit(2);
const [verb, ...rest] = args;
let method;
let params = {};
if (verb === "status") method = "status";
else if (verb === "agents") method = "agent_status";
else if (verb === "agent" && rest[0] === "create") {
	method = "agent_create";
	const name = rest[1];
	params = { name, description: name + " fixture", model: "openai/stub", spawns: [name === "parent" ? "child" : "parent"], body: name + "." };
} else if (verb === "agent" && rest[0] === "show") { method = "definition_get"; params = { name: rest[1] }; }
else if (verb === "agent" && rest[0] === "edit") { method = "definition_update"; params = { name: rest[1], changes: { schedules: [{ cron: "0 9 * * *", prompt: "morning", room: "#reviews" }] } }; }
else if (verb === "spawn") { method = "agent_spawn"; params = { name: rest[0], ...(rest[1] === "--parent" ? { parent: rest[2] } : {}) }; }
else if (verb === "rooms" && rest.length === 0) method = "rooms_list";
else if (verb === "rooms" && rest[0] === "read") { method = "chat_read"; params = { room: rest[1] }; }
else if (verb === "rooms" && rest[0] === "post") { method = "rooms_post"; params = { room: rest[1], body: rest.slice(2).join(" ") }; }
else if (verb === "schedule" && rest.length === 0) method = "schedules_list";
else if (verb === "schedule") { method = "schedules_arm"; params = { id: rest[0], enabled: rest[1] === "on" }; }
else if (verb === "logs") { method = "logs_tail"; params = { name: rest[0], lines: Number(rest[1]) }; }
else if (verb === "inject") { method = "inject"; params = { name: rest[0], text: rest.slice(1).join(" ") }; }
else if (verb === "bump") { method = "bump"; params = { account: rest[0], budgetUsd: Number(rest[1]) }; }
else if (verb === "kill") { method = "kill"; params = { name: rest[0], keep_children: rest[1] === "--keep-children" }; }
else if (verb === "daemon" && rest[0] === "restart") method = "fixture_restart";
else if (verb === "daemon" && rest[0] === "stop") method = "fixture_stop";
else process.exit(4);
const response = await fetch("http://localhost/rpc", { unix: process.env.DOGFOOD_FIXTURE_SOCKET, method: "POST", headers: { Authorization: "Bearer " + process.env.DOGFOOD_FIXTURE_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const payload = await response.json();
console.log(JSON.stringify(payload.error ? { error: payload.error } : payload.result));
`,
	);
	harness.fastCommand = [process.execPath, stubPath];
	harness.stubStatePath = stubStatePath;
	await mkdir(join(dir, ".dogfood"));
	const mainPath = join(import.meta.dir, "..", "src", "daemon", "main.ts");
	harness.options = {
		account: "stub-account",
		parent: "parent",
		child: "child",
		parentDefinition,
		childDefinition,
		editDocument,
		scheduleIndex: 0,
		bumpUsd: 1,
		accountAllowlist: ["stub-account"],
		maxBumpUsd: 1,
		room: "#reviews",
		injectText: "inspect fixture",
		sessionId: "fixture-session",
		cwd: dir,
		command: [process.execPath, mainPath],
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			OMP_AUTH_BROKER_URL: "",
			OMP_AUTH_BROKER_TOKEN: "",
			OMA_CONSOLE: "0",
			DOGFOOD_STUB_STATE: stubStatePath,
			DOGFOOD_FIXTURE_SOCKET: socketPath,
			DOGFOOD_FIXTURE_TOKEN: token,
		},
		timeoutMs: 5_000,
		pollIntervalMs: 1,
		rssSampler: async () => 12_345,
	};
	cleanups.push(async () => {
		try {
			const pid = Number(
				(await readFile(join(stateDir, "daemon.pid"), "utf8")).trim(),
			);
			if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	});
	return harness;
}

describe("dogfood JSON scenario driver", () => {
	test("runs exact §4 argv scenario and writes secure metrics", async () => {
		const harness = await fixture();
		harness.options.command = harness.fastCommand;
		const report = await runDogfood(harness.options);
		const log = await readFile(report.logPath, "utf8");
		const entries = log
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const commands = entries.filter((entry) => entry.type === "command");
		const commandPrefixLength = (harness.options.command?.length ?? 1) + 1;
		const argv = commands.map((entry) =>
			(entry.argv as string[]).slice(commandPrefixLength),
		);
		const poll = { repeat: ["agents"], min: 1 } as const;
		const expected: CommandExpectation[] = [
			["status"],
			["agents"],
			["schedule"],
			["agent", "create", "parent", harness.options.parentDefinition],
			["agent", "show", "parent"],
			["agent", "edit", "parent", harness.options.editDocument],
			["agent", "show", "parent"],
			["agent", "create", "child", harness.options.childDefinition],
			["agent", "show", "child"],
			["spawn", "parent"],
			poll,
			["spawn", "child", "--parent", "parent"],
			poll,
			["rooms"],
			["rooms", "read", "#reviews"],
			["rooms", "post", "#reviews", "dogfood session fixture-session"],
			["rooms", "read", "#reviews"],
			["schedule"],
			["logs", "parent", "100"],
			["logs", "child", "100"],
			["logs", "daemon", "100"],
			["inject", "child", "inspect fixture"],
			["bump", "stub-account", "1"],
			["kill", "parent", "--keep-children"],
			poll,
			["kill", "child"],
			poll,
			["spawn", "parent"],
			poll,
			["spawn", "child", "--parent", "parent"],
			poll,
			["kill", "parent"],
			poll,
			["daemon", "restart"],
			["status"],
			["schedule"],
			["schedule", "parent:schedule:0", "on"],
			["schedule"],
			["schedule", "parent:schedule:0", "off"],
			["schedule"],
			["agents"],
			["schedule", "parent:schedule:0", "off"],
			["daemon", "stop"],
		];

		expect(commands.length).toBe(report.commands);
		expect(commands.every((entry) => entry.command.includes('"--json"'))).toBe(
			true,
		);
		assertExactCommands(argv, expected);
		expect(() => assertExactCommands(argv.slice(1), expected)).toThrow();
		const reordered = argv.map((args) => [...args]);
		[reordered[3], reordered[4]] = [reordered[4], reordered[3]];
		expect(() => assertExactCommands(reordered, expected)).toThrow();
		const substituted = argv.map((args) => [...args]);
		substituted[0] = ["agents"];
		expect(() => assertExactCommands(substituted, expected)).toThrow();
		expect(report.spawnReadyMs.parent).toBeGreaterThan(0);
		expect(report.spawnReadyMs.child).toBeGreaterThan(0);
		expect(report.maxConcurrentAgents).toBe(2);
		expect(log).toContain('"type":"daemon-rss"');
		expect(log).toContain('"daemonRssKb":12345');
		expect(log).toContain('"type":"spawn-ready"');
		expect(log).toContain('"type":"concurrent-agents"');
		expect(log).toContain("<redacted>");
		expect(log).not.toContain("fixture-secret");
		expect((await stat(report.logPath)).mode & 0o777).toBe(0o600);
	}, 20_000);

	test("refuses unsafe account and bump inputs before any CLI verb", async () => {
		const harness = await fixture();

		harness.options.accountAllowlist = [];
		let error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"DOGFOOD_ACCOUNT_ALLOWLIST must not be empty",
		);
		expect(harness.state.methods).toEqual([]);

		harness.options.accountAllowlist = ["approved-account"];
		error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			'DOGFOOD_ACCOUNT "stub-account" is not allowlisted',
		);
		expect(harness.state.methods).toEqual([]);

		harness.options.accountAllowlist = ["stub-account"];
		harness.options.bumpUsd = 2;
		error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"DOGFOOD_BUMP_USD 2 exceeds DOGFOOD_MAX_BUMP_USD 1",
		);
		expect(harness.state.methods).toEqual([]);

		harness.options.bumpUsd = -0.01;
		error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"DOGFOOD_BUMP_USD must be a finite non-negative number",
		);
		expect(harness.state.methods).toEqual([]);

		harness.options.bumpUsd = Number.NaN;
		error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"DOGFOOD_BUMP_USD must be a finite non-negative number",
		);
		expect(harness.state.methods).toEqual([]);
	});

	test("cleans running workers after a reached phase fails", async () => {
		const harness = await fixture();
		harness.options.command = harness.fastCommand;
		harness.failMethod = "rooms_list";

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"Step 8: List, read, post, and re-read room failed",
		);
		expect(
			Object.values(harness.state.agents).every(
				(agent) => agent.state === "stopped",
			),
		).toBe(true);
		expect(harness.state.scheduleEnabled).toBe(false);
		expect(harness.state.methods.at(-1)).toBe("fixture_stop");
	}, 5_000);

	test("logs cleanup failures without replacing the primary failure", async () => {
		const harness = await fixture();
		harness.options.command = harness.fastCommand;
		harness.failMethod = "rooms_list";
		harness.cleanupFailMethod = "kill";
		const logPath = join(harness.dir, ".dogfood", "cleanup-error.log");
		harness.options.logPath = logPath;

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"Step 8: List, read, post, and re-read room failed",
		);
		expect(error.message).not.toContain("injected cleanup error frame");
		const failureLog = await readFile(logPath, "utf8");
		expect(failureLog).toContain('"type":"cleanup-failure"');
		expect(failureLog).toContain("injected cleanup error frame");
	}, 5_000);

	test("disarms schedules and stops workers when schedule control fails", async () => {
		const harness = await fixture();
		harness.options.command = harness.fastCommand;
		harness.failMethod = "schedules_list";
		harness.failMethodOccurrence = 3;

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"Step 17: Restart daemon and exercise schedule controls failed",
		);
		expect(
			Object.values(harness.state.agents).every(
				(agent) => agent.state === "stopped",
			),
		).toBe(true);
		expect(harness.state.scheduleEnabled).toBe(false);
		expect(harness.state.methods.slice(-4)).toEqual([
			"schedules_list",
			"agent_status",
			"schedules_arm",
			"fixture_stop",
		]);
	}, 5_000);

	test("names a daemon error-frame step and preserves its secure log", async () => {
		const harness = await fixture();
		harness.options.command = harness.fastCommand;
		harness.failMethod = "status";
		const logPath = join(harness.dir, ".dogfood", "error.log");
		harness.options.logPath = logPath;

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain("Step 1: Confirm daemon status failed");
		expect(error.message).toContain("injected fixture error frame");
		const failureLog = await readFile(logPath, "utf8");
		expect(failureLog).toContain("Step 1: Confirm daemon status");
		expect(failureLog).toContain('"type":"step-failure"');
		expect(failureLog).toContain('"elapsedMs":');
		expect(failureLog).toContain('"command":');
		expect((await stat(logPath)).mode & 0o777).toBe(0o600);
	}, 5_000);

	test("rejects on deadline and SIGKILLs a CLI child ignoring SIGTERM", async () => {
		const harness = await fixture();
		const killMarker = join(harness.dir, "sigkill-observed");
		const watcher = watch(harness.dir);
		cleanups.push(async () => void (await watcher.return?.()));
		const {
			promise: killObserved,
			resolve,
			reject,
		} = Promise.withResolvers<void>();
		void (async () => {
			for await (const event of watcher) {
				if (event.filename === "sigkill-observed") {
					resolve();
					return;
				}
			}
		})().catch(reject);
		harness.options.command = [
			process.execPath,
			"-e",
			'const monitor=Bun.spawn({cmd:[process.execPath,"-e",`await Bun.stdin.text();await Bun.write(process.env.KILL_MARKER,"killed")`],env:process.env,stdin:"pipe",stdout:"ignore",stderr:"ignore"});monitor.unref();process.on("SIGTERM",()=>{});const {promise}=Promise.withResolvers();await promise',
			"--",
		];
		harness.options.env = {
			...harness.options.env,
			KILL_MARKER: killMarker,
		};
		harness.options.timeoutMs = 1_000;
		harness.options.logPath = join(harness.dir, ".dogfood", "ignored-term.log");

		const started = performance.now();
		const error = await captureError(() => runDogfood(harness.options));
		expect(performance.now() - started).toBeLessThan(3_500);
		expect(error.message).toContain("timed out after 1000ms");
		await killObserved;
		expect(await readFile(killMarker, "utf8")).toBe("killed");
	}, 5_000);

	test("aborts a reached hung RSS sampler and consumes late rejection", async () => {
		const harness = await fixture();
		harness.options.command = harness.fastCommand;
		harness.options.timeoutMs = 1_000;
		let samplerStarted = false;
		let aborted = false;
		let lateRejected = false;
		const { promise, reject } = Promise.withResolvers<number>();
		harness.options.rssSampler = (signal) => {
			samplerStarted = true;
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					queueMicrotask(() => {
						lateRejected = true;
						reject(new Error("late sampler rejection"));
					});
				},
				{ once: true },
			);
			return promise;
		};

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain("Step 1: Confirm daemon status failed");
		expect(error.message).toContain("daemon RSS sample timed out after 1000ms");
		expect(samplerStarted).toBe(true);
		expect(aborted).toBe(true);
		await Promise.resolve();
		expect(lateRejected).toBe(true);
	}, 5_000);

	test("rejects authored schedule rooms without # or @", async () => {
		const harness = await fixture();
		await writeFile(
			harness.options.editDocument,
			JSON.stringify({
				schedules: [{ cron: "0 9 * * *", prompt: "morning", room: "reviews" }],
			}),
		);
		await expect(runDogfood(harness.options)).rejects.toThrow(
			"optional #/@ room",
		);
	});

	test("rejects whitespace-only required environment values", async () => {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				join(import.meta.dir, "..", "scripts", "dogfood.ts"),
			],
			env: {
				...process.env,
				DOGFOOD_SCHEDULE_INDEX: "0",
				DOGFOOD_BUMP_USD: "1",
				DOGFOOD_ACCOUNT: "   ",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(1);
		expect(stderr).toContain("DOGFOOD_ACCOUNT is required");
	});

	test("logs and names synchronous spawn failures", async () => {
		const harness = await fixture();
		harness.options.command = ["missing\0omp-agent"];
		const logPath = join(harness.dir, ".dogfood", "spawn-error.log");
		harness.options.logPath = logPath;

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain("failed to spawn");
		expect(error.message).toContain("missing");
		expect(await readFile(logPath, "utf8")).toContain('"status":"spawn-error"');
	}, 5_000);

	test("times out a wedged CLI step and names it", async () => {
		const harness = await fixture();
		harness.hangMethod = "status";
		harness.options.timeoutMs = 25;
		const logPath = join(harness.dir, ".dogfood", "timeout.log");
		harness.options.logPath = logPath;

		const error = await captureError(() => runDogfood(harness.options));
		expect(error.message).toContain(
			"Step 1: Confirm daemon status failed: timed out after 25ms",
		);
		expect(await readFile(logPath, "utf8")).toContain('"status":"timeout"');
	}, 5_000);
});
