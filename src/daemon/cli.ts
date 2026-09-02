/**
 * Purpose: Shell-only daemon management. `omp-agent <verb>` speaks JSON-RPC
 * over the daemon's unix socket and renders a scriptable result without an OMP
 * session or TUI.
 *
 * Public API: `createCliClient`, `runCli`, `CliIo`, and `DaemonClient`.
 *
 * Failure modes: socket refusal is rendered as the one daemon-down sentence;
 * JSON-RPC errors preserve the daemon's message; malformed CLI args render the
 * complete usage and return exit code 2.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, parseFrontmatter } from "@oh-my-pi/pi-utils";

import { parsePeerDefinition } from "../shared/agent-definition";

import type {
	AgentCreateResult,
	AgentSpawnResult,
	AgentStatus,
	AgentStatusResult,
	BumpResult,
	ChatReadResult,
	DaemonStopResult,
	DefinitionGetResult,
	DefinitionUpdateResult,
	InjectResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	KillResult,
	LogsTailResult,
	MethodName,
	RoomsListResult,
	RoomsPostResult,
	SchedulesArmResult,
	SchedulesListResult,
	StatusResult,
} from "../shared/protocol";
import { METHODS } from "../shared/protocol-schemas";

const STATE_DIR = "oh-my-agent";
const CONSOLE_URL_FILE = "console-url";
const CONSOLE_TOKEN_FILE = "console-token";
const PID_FILE = "daemon.pid";

/**
 * The daemon binary, resolved from this module rather than from `process.argv`.
 *
 * `daemon restart` re-launches it, and argv[1] is whatever wrapper invoked the
 * CLI — a shim, a bundled entry, a test harness — which is not necessarily the
 * daemon at all.
 */
const MAIN_PATH = join(import.meta.dir, "main.ts");

export const DAEMON_UNAVAILABLE =
	"oh-my-agent daemon not running — start it with `omp-agent daemon`.";

export interface CliIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export interface DaemonClient {
	call<T>(method: MethodName, params?: unknown): Promise<T>;
}

/** Socket missing or refusing connections is one operator-facing condition. */
export class DaemonUnavailableError extends Error {
	constructor() {
		super(DAEMON_UNAVAILABLE);
		this.name = "DaemonUnavailableError";
	}
}

class UsageError extends Error {}

/** A daemon replied with an error frame; its message is operator-safe output. */
class DaemonRpcError extends Error {}

/** Full command reference, emitted for every CLI parsing error. */
export const USAGE = `Usage: omp-agent [--json] <verb> [args]

Flags come before the verb; anything after \`--\` is payload, so a literal
--json inside a message is never eaten. Errors are always plain text,
never JSON.

Verbs:
  status
  agents
  agent create <name> <file|->
  agent show <name>
  agent edit <name> <file|->
  spawn <name> [--parent <parent>]
  kill <name> [--keep-children]
  rooms
  rooms read <room>
  rooms post <room> <text...>
  schedule
  schedule <id> on|off
  logs <name|daemon> [n]
  inject <name> <text...>
  bump <account> <usd>
  console
  daemon stop
  daemon restart
`;

/** Equivalent to the extension client, kept local so daemon never imports UI. */
export function createCliClient(
	socketPath: string,
	operatorToken?: string,
): DaemonClient {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (operatorToken !== undefined && operatorToken.length > 0) {
		headers.Authorization = `Bearer ${operatorToken}`;
	}
	let nextId = 0;
	return {
		async call<T>(method: MethodName, params?: unknown): Promise<T> {
			const outgoing = params ?? {};
			// `keep_children` is an additive kill field deliberately omitted from
			// METHODS. Validate the declared shape without rejecting that extra key.
			const paramsCheck = METHODS[method].validateParams(outgoing);
			if (!paramsCheck.ok) {
				throw new Error(
					`invalid ${method} params at ${paramsCheck.field}: ${paramsCheck.message}`,
				);
			}

			let response: Response;
			try {
				nextId += 1;
				response = await fetch("http://localhost/rpc", {
					unix: socketPath,
					method: "POST",
					headers,
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: nextId,
						method,
						params: outgoing,
					}),
				});
			} catch {
				throw new DaemonUnavailableError();
			}

			const frame = (await response.json()) as JsonRpcSuccess | JsonRpcFailure;
			if ("error" in frame) throw new DaemonRpcError(frame.error.message);
			const resultCheck = METHODS[method].validateResult(frame.result);
			if (!resultCheck.ok) {
				throw new Error(
					`invalid ${method} result at ${resultCheck.field}: ${resultCheck.message}`,
				);
			}
			return resultCheck.value as T;
		},
	};
}

function write(
	io: CliIo,
	stdout: boolean,
	value: unknown,
	json: boolean,
): void {
	const text = json ? JSON.stringify(value) : String(value);
	(stdout ? io.stdout : io.stderr)(`${text}\n`);
}

function output(io: CliIo, value: unknown, json: boolean, human: string): void {
	write(io, true, json ? value : human, json);
}

function requireArg(args: string[], index: number): string {
	const value = args[index];
	if (value === undefined || value.length === 0) throw new UsageError();
	return value;
}

function requireText(args: string[], index: number): string {
	const text = args.slice(index).join(" ");
	if (text.length === 0) throw new UsageError();
	return text;
}

function formatAgent(agent: AgentStatus): string {
	const tree = [
		agent.parent === undefined ? "" : `parent=${agent.parent}`,
		agent.children === undefined || agent.children.length === 0
			? ""
			: `children=${agent.children.join(",")}`,
	]
		.filter(Boolean)
		.join(" ");
	return [agent.name, agent.state, agent.account, tree]
		.filter(Boolean)
		.join("\t");
}

async function status(
	client: DaemonClient,
	io: CliIo,
	json: boolean,
): Promise<void> {
	const result = await client.call<StatusResult>("status", {});
	output(
		io,
		result,
		json,
		`protocol: ${result.protocolVersion}\nuptime: ${result.uptimeMs}ms\nagents: ${result.agents.length}`,
	);
}

async function agents(
	client: DaemonClient,
	io: CliIo,
	json: boolean,
): Promise<void> {
	const result = await client.call<AgentStatusResult>("agent_status", {});
	output(io, result, json, result.agents.map(formatAgent).join("\n"));
}

async function spawn(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	const name = requireArg(args, 1);
	let parent: string | undefined;
	if (args.length > 2) {
		if (args[2] !== "--parent" || args.length !== 4) throw new UsageError();
		parent = requireArg(args, 3);
	}
	const result = await client.call<AgentSpawnResult>("agent_spawn", {
		name,
		...(parent === undefined ? {} : { parent }),
	});
	output(io, result, json, `${result.name}\t${result.state}`);
}

async function kill(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	const name = requireArg(args, 1);
	if (args.length > 3 || (args.length === 3 && args[2] !== "--keep-children")) {
		throw new UsageError();
	}
	const params =
		args[2] === "--keep-children" ? { name, keep_children: true } : { name };
	const result = await client.call<KillResult>("kill", params);
	output(io, result, json, `${result.name}\t${result.state}`);
}

async function rooms(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	if (args.length === 1) {
		const result = await client.call<RoomsListResult>("rooms_list", {});
		output(
			io,
			result,
			json,
			result.rooms
				.map((room) => `${room.id}\t${room.kind}\t${room.name}`)
				.join("\n"),
		);
		return;
	}

	if (args[1] === "read" && args.length === 3) {
		const room = requireArg(args, 2);
		const result = await client.call<ChatReadResult>("chat_read", { room });
		output(
			io,
			result,
			json,
			result.messages
				.map((message) => `${message.id}\t${message.author}\t${message.body}`)
				.join("\n"),
		);
		return;
	}

	if (args[1] === "post") {
		const room = requireArg(args, 2);
		const body = requireText(args, 3);
		const result = await client.call<RoomsPostResult>("rooms_post", {
			room,
			body,
		});
		output(io, result, json, `message: ${result.messageId}`);
		return;
	}

	throw new UsageError();
}

async function schedule(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	if (args.length === 1) {
		const result = await client.call<SchedulesListResult>("schedules_list", {});
		output(
			io,
			result,
			json,
			result.schedules
				.map(
					(item) =>
						`${item.id}\t${item.enabled ? "on" : "off"}\t${item.cron ?? item.action}`,
				)
				.join("\n"),
		);
		return;
	}

	if (args.length !== 3) throw new UsageError();
	const scheduleId = requireArg(args, 1);
	const enabled =
		args[2] === "on" ? true : args[2] === "off" ? false : undefined;
	if (enabled === undefined) throw new UsageError();
	const result = await client.call<SchedulesArmResult>("schedules_arm", {
		scheduleId,
		enabled,
	});
	output(
		io,
		result,
		json,
		`${result.schedule.id}\t${result.schedule.enabled ? "on" : "off"}`,
	);
}

/**
 * `logs <name|daemon> [n]` — a stderr tail from one worker, or the daemon.
 *
 * `daemon` is a literal selector rather than a peer lookup: it maps to the
 * protocol's `source`, so a peer that happens to be named "daemon" still has
 * its own logs reachable by every other client.
 */
async function logs(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	const name = requireArg(args, 1);
	if (args.length > 3) throw new UsageError();
	const lines = args[2] === undefined ? undefined : Number(args[2]);
	if (lines !== undefined && (!Number.isInteger(lines) || lines <= 0)) {
		throw new UsageError();
	}
	const result = await client.call<LogsTailResult>("logs_tail", {
		name,
		...(lines === undefined ? {} : { lines }),
		...(name === "daemon" ? { source: "daemon" as const } : {}),
	});
	output(io, result, json, result.lines.join("\n"));
}

async function inject(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	const name = requireArg(args, 1);
	const message = requireText(args, 2);
	const result = await client.call<InjectResult>("inject", { name, message });
	output(
		io,
		result,
		json,
		`${result.name}\t${result.queued ? "queued" : "sent"}`,
	);
}

async function bump(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	const account = requireArg(args, 1);
	if (args.length !== 3) throw new UsageError();
	const budgetUsd = Number(requireArg(args, 2));
	if (!Number.isFinite(budgetUsd)) throw new UsageError();
	const result = await client.call<BumpResult>("bump", { account, budgetUsd });
	output(io, result, json, `${result.account}\t${result.budgetUsd}`);
}

/**
 * How a document reaches `agent create`/`agent edit`: a file path, or `-` for
 * stdin.
 *
 * The source is always an explicit argument rather than "a path, or stdin when
 * omitted". A verb whose arity decides whether it blocks on a pipe hangs when
 * an operator simply forgot the filename, and a script that meant to pass a
 * path but computed an empty one would silently wait forever instead of
 * failing. `-` is the shell's own convention for "this one is the pipe".
 */
async function readDocument(
	source: string,
	readStdin: () => Promise<string>,
): Promise<string> {
	if (source === "-") return await readStdin();
	try {
		return await readFile(source, "utf8");
	} catch (error) {
		// A missing or unreadable file is something the operator got wrong,
		// not a daemon fault: it exits 4 with the path, not a stack trace.
		throw new DaemonRpcError(
			`cannot read ${source}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
		);
	}
}

/**
 * Fields `agent_create` accepts, exactly as `METHODS.agent_create` declares
 * them.
 *
 * A whitelist over what the *document declared*, not over the parsed result:
 * `parsePeerDefinition` fills in defaults and spreads native runtime keys, so
 * a projection of the parse alone cannot tell an operator's `tools:` from a
 * default the parser supplied. Anything authored and outside this list is
 * refused rather than dropped — see `agentCreate`.
 */
const CREATE_KEYS = [
	"name",
	"description",
	"model",
	"rooms",
	"wake",
	"autonomy",
	"spawns",
	"body",
] as const;

/**
 * `agent create <name> <file|->` — author a definition without starting it.
 *
 * The document is parsed here as well as by the daemon, for one reason: a
 * local parse gives the operator the parser's own words with the file still in
 * front of them, and the daemon's parse remains the gate that decides what
 * lands on disk. Creation never spawns; `spawn` is the second, deliberate call.
 *
 * `agent_create`'s params are a strict subset of what a definition file may
 * declare, so a document carrying `tools:`, `schedules:`, or any other valid
 * field the method cannot send is refused rather than quietly created without
 * it. Writing a peer that differs from the document the operator handed over,
 * and reporting success for it, is the same silent lie the console's PATCH
 * validation exists to prevent. Those fields are reachable through
 * `agent edit`, which speaks `definition_update` and carries all of them.
 */
async function agentCreate(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
	readStdin: () => Promise<string>,
): Promise<void> {
	if (args.length !== 4) throw new UsageError();
	const name = requireArg(args, 2);
	const content = await readDocument(requireArg(args, 3), readStdin);

	let parsed: Record<string, unknown>;
	try {
		parsed = parsePeerDefinition(`${name}.md`, content) as unknown as Record<
			string,
			unknown
		>;
	} catch (error) {
		throw new DaemonRpcError(
			error instanceof Error ? error.message : String(error),
		);
	}

	// Refused, never silently overridden: the argument names the file the
	// daemon will write, so a document whose frontmatter disagrees would
	// otherwise create a peer under a name the operator never typed — and
	// whose own `name:` field then contradicts its filename on the next boot.
	if (parsed.name !== name) {
		throw new DaemonRpcError(
			`document declares name ${JSON.stringify(parsed.name)}, but the command names ${JSON.stringify(name)}`,
		);
	}

	// What the document actually declared, before the parser's defaults and
	// native spread. `parsePeerDefinition` returns `tools` and friends whether
	// or not anyone wrote them, so the parse alone cannot distinguish an
	// operator's field from a default — and refusing on the parse would reject
	// every document, while projecting it drops real authorship.
	const { frontmatter } = parseFrontmatter(content, {
		location: `${name}.md`,
		level: "fatal",
		normalize: true,
	});
	const unsupported = Object.keys(frontmatter).filter(
		(key) => !CREATE_KEYS.includes(key as (typeof CREATE_KEYS)[number]),
	);
	if (unsupported.length > 0) {
		throw new DaemonRpcError(
			`agent create cannot send ${unsupported.sort().join(", ")}; ` +
				`remove ${unsupported.length === 1 ? "it" : "them"} and set ${unsupported.length === 1 ? "it" : "them"} with \`agent edit\` once the peer exists`,
		);
	}

	const params: Record<string, unknown> = {};
	for (const key of CREATE_KEYS) {
		const value = parsed[key];
		if (value !== undefined) params[key] = value;
	}

	const result = await client.call<AgentCreateResult>("agent_create", params);
	output(
		io,
		result,
		json,
		`${result.name}\t${result.created ? "created" : "unchanged"}`,
	);
}

/** `agent show <name>` — the definition the daemon holds, and its path. */
async function agentShow(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
): Promise<void> {
	if (args.length !== 3) throw new UsageError();
	const name = requireArg(args, 2);
	const result = await client.call<DefinitionGetResult>("definition_get", {
		name,
	});
	// The path, then the definition as JSON. Not a re-rendered markdown
	// document: `agent edit` consumes a changes object, so emitting something
	// that looked like a definition file would suggest a round-trip this pair
	// of verbs does not have. `--json` carries the whole protocol result.
	output(
		io,
		result,
		json,
		`${result.filePath}\n${JSON.stringify(result.definition, null, 2)}`,
	);
}

/**
 * `agent edit <name> <file|->` — apply a changes document.
 *
 * A JSON object of changed fields rather than a whole re-rendered definition:
 * `definition_update` takes exactly that, so this maps to the protocol without
 * inventing a second merge rule that could disagree with the daemon's. The
 * daemon's validator refuses unknown keys, and its message is passed through
 * verbatim — a typo'd field must not be silently dropped.
 */
async function agentEdit(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
	readStdin: () => Promise<string>,
): Promise<void> {
	if (args.length !== 4) throw new UsageError();
	const name = requireArg(args, 2);
	const raw = await readDocument(requireArg(args, 3), readStdin);

	let changes: unknown;
	try {
		changes = JSON.parse(raw);
	} catch (error) {
		throw new DaemonRpcError(
			`changes must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof changes !== "object" ||
		changes === null ||
		Array.isArray(changes)
	) {
		throw new DaemonRpcError("changes must be a JSON object");
	}

	const result = await client.call<DefinitionUpdateResult>(
		"definition_update",
		{ name, changes },
	);
	// `rebuildRequired` is the operator-facing half of the answer: a policy
	// edit is absorbed by the next delivery's rebuild, a rooms-only edit is
	// already live, and saying which happened is the whole point of the field.
	output(
		io,
		result,
		json,
		`${result.name}\t${result.rebuildRequired ? "rebuild-required" : "live"}`,
	);
}

/** `agent <create|show|edit>` — definition authoring over the frozen methods. */
async function agent(
	client: DaemonClient,
	args: string[],
	io: CliIo,
	json: boolean,
	readStdin: () => Promise<string>,
): Promise<void> {
	switch (args[1]) {
		case "create":
			await agentCreate(client, args, io, json, readStdin);
			return;
		case "show":
			await agentShow(client, args, io, json);
			return;
		case "edit":
			await agentEdit(client, args, io, json, readStdin);
			return;
		default:
			throw new UsageError();
	}
}

async function consoleUrl(
	client: DaemonClient,
	stateDir: string,
	io: CliIo,
): Promise<void> {
	let url: string;
	try {
		url = (await readFile(join(stateDir, CONSOLE_URL_FILE), "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await client.call("status", {});
		throw new DaemonRpcError(
			"oh-my-agent console is disabled for this daemon.",
		);
	}
	if (url.length === 0) {
		await client.call("status", {});
		throw new DaemonRpcError(
			"oh-my-agent console is disabled for this daemon.",
		);
	}
	write(io, true, url, false);
}

/** How long `daemon stop` waits for the daemon to actually disappear. */
const STOP_DEADLINE_MS = 15_000;

/** How often that wait re-checks. Short: the daemon usually exits promptly. */
const STOP_POLL_MS = 50;

/** Whether a pid still names a live process. */
function alive(pid: number): boolean {
	try {
		// Signal 0 checks for existence without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else: still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Stop the daemon and return only once it is verifiably gone.
 *
 * The RPC acknowledges before shutting down, so the ack alone means "shutdown
 * started", not "daemon stopped" — and `daemon restart` is only safe to launch
 * into a state where the pidfile is free. So this waits for both the process
 * and the pidfile to disappear, which is exactly what the next boot's
 * `claimPidfile` will check.
 *
 * Polling is unavoidable here: the daemon is another OS process this one is not
 * the parent of, so there is no exit event to await, and the pidfile's removal
 * is the only signal it publishes.
 */
async function stopDaemon(
	client: DaemonClient,
	stateDir: string,
): Promise<DaemonStopResult> {
	const acked = await client.call<DaemonStopResult>("daemon_stop", {});
	const pidPath = join(stateDir, PID_FILE);

	const deadline = Date.now() + STOP_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (!alive(acked.pid) && !existsSync(pidPath)) return acked;
		await Bun.sleep(STOP_POLL_MS);
	}
	throw new DaemonRpcError(
		`oh-my-agent daemon (pid ${acked.pid}) did not stop within ${STOP_DEADLINE_MS / 1000}s; ` +
			`it is still running or ${pidPath} was left behind.`,
	);
}

async function daemon(
	client: DaemonClient,
	args: string[],
	agentDir: string,
	io: CliIo,
	json: boolean,
): Promise<void> {
	if (args.length !== 2) throw new UsageError();
	const action = args[1];
	if (action !== "stop" && action !== "restart") throw new UsageError();

	const stopped = await stopDaemon(client, join(agentDir, STATE_DIR));
	if (action === "stop") {
		output(io, stopped, json, `stopped\t${stopped.pid}`);
		return;
	}

	// Only now, with the pidfile released, can a new daemon claim it. The
	// launcher is the same one `omp-agent daemon` runs, so a restart and a cold
	// start produce identical daemons rather than two boot paths to keep in step.
	//
	// `PI_CODING_AGENT_DIR` is set explicitly rather than inherited: this CLI
	// may have been pointed at a profile by `--agentDir`, and a replacement that
	// read the ambient environment would boot a different profile than the one
	// just stopped.
	const launcher = Bun.spawn({
		cmd: [process.execPath, MAIN_PATH, "daemon"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exitCode = await launcher.exited;
	if (exitCode !== 0) {
		const stderr = (await new Response(launcher.stderr).text()).trim();
		throw new DaemonRpcError(
			`oh-my-agent daemon failed to restart (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ""}`,
		);
	}
	// The launcher exits only after the child announces, and the child announces
	// only once its socket is served — so this line is proof the replacement is
	// up, not merely spawned.
	const started = (await new Response(launcher.stdout).text()).trim();
	output(
		io,
		{ stopped: stopped.pid, socket: started.split("\n", 1)[0] ?? "" },
		json,
		`restarted\t${started.split("\n", 1)[0] ?? ""}`,
	);
}

export async function runCli(
	argv: string[],
	opts: {
		agentDir?: string;
		io?: CliIo;
		/**
		 * How `-` reads a document. A seam rather than a direct
		 * `Bun.stdin.text()` call so a test can drive `agent create -` many
		 * times in one process: a real stdin is consumed once, and every
		 * later read would block on a stream nobody is writing to.
		 */
		readStdin?: () => Promise<string>;
	} = {},
): Promise<number> {
	// Flags are parsed only up to the first positional: a literal "--json"
	// inside a message body is payload, not a flag. "--" ends flag parsing
	// explicitly for the same reason.
	const flagEnd = argv.findIndex(
		(arg) => arg === "--" || !arg.startsWith("--"),
	);
	const flagPart = flagEnd === -1 ? argv : argv.slice(0, flagEnd);
	const positional =
		flagEnd === -1
			? []
			: argv.slice(argv[flagEnd] === "--" ? flagEnd + 1 : flagEnd);
	const json = flagPart.includes("--json");
	const args = positional;
	const agentDir =
		opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const stateDir = join(agentDir, STATE_DIR);
	// A missing token (daemon never booted, or booted before T-1004) is not
	// this CLI's problem to diagnose: an absent socket answers
	// DaemonUnavailableError regardless, and a live socket answers its own
	// Unauthorized, which is the daemon's word on the matter either way.
	let operatorToken: string | undefined;
	try {
		operatorToken = (
			await readFile(join(stateDir, CONSOLE_TOKEN_FILE), "utf8")
		).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const client = createCliClient(join(stateDir, "daemon.sock"), operatorToken);
	const io = opts.io ?? {
		stdout: (text: string) => process.stdout.write(text),
		stderr: (text: string) => process.stderr.write(text),
	};
	const readStdin = opts.readStdin ?? (() => Bun.stdin.text());

	try {
		switch (args[0]) {
			case "status":
				if (args.length !== 1) throw new UsageError();
				await status(client, io, json);
				return 0;
			case "agents":
				if (args.length !== 1) throw new UsageError();
				await agents(client, io, json);
				return 0;
			case "agent":
				await agent(client, args, io, json, readStdin);
				return 0;
			case "spawn":
				await spawn(client, args, io, json);
				return 0;
			case "kill":
				await kill(client, args, io, json);
				return 0;
			case "rooms":
				await rooms(client, args, io, json);
				return 0;
			case "schedule":
				await schedule(client, args, io, json);
				return 0;
			case "logs":
				await logs(client, args, io, json);
				return 0;
			case "inject":
				await inject(client, args, io, json);
				return 0;
			case "bump":
				await bump(client, args, io, json);
				return 0;
			case "console":
				if (args.length !== 1) throw new UsageError();
				await consoleUrl(client, stateDir, io);
				return 0;
			case "daemon":
				await daemon(client, args, agentDir, io, json);
				return 0;
			default:
				throw new UsageError();
		}
	} catch (error) {
		if (error instanceof DaemonUnavailableError) {
			write(io, false, DAEMON_UNAVAILABLE, false);
			return 3;
		}
		if (error instanceof UsageError) {
			write(io, false, USAGE, false);
			return 2;
		}
		if (error instanceof DaemonRpcError) {
			write(io, false, error.message, false);
			return 4;
		}
		write(
			io,
			false,
			error instanceof Error ? error.message : String(error),
			false,
		);
		return 4;
	}
}
