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
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@oh-my-pi/pi-utils";

import type {
	AgentSpawnResult,
	AgentStatus,
	AgentStatusResult,
	BumpResult,
	ChatReadResult,
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
  spawn <name> [--parent <parent>]
  kill <name> [--keep-children]
  rooms
  rooms read <room>
  rooms post <room> <text...>
  schedule
  schedule <id> on|off
  logs <name> [n]
  inject <name> <text...>
  bump <account> <usd>
  console
`;

/** Equivalent to the extension client, kept local so daemon never imports UI. */
export function createCliClient(socketPath: string): DaemonClient {
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
					headers: { "Content-Type": "application/json" },
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

async function consoleUrl(
	client: DaemonClient,
	stateDir: string,
	io: CliIo,
	json: boolean,
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
	output(io, { url }, json, url);
}

export async function runCli(
	argv: string[],
	opts: { agentDir?: string; io?: CliIo } = {},
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
	const client = createCliClient(join(stateDir, "daemon.sock"));
	const io = opts.io ?? {
		stdout: (text: string) => process.stdout.write(text),
		stderr: (text: string) => process.stderr.write(text),
	};

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
				await consoleUrl(client, stateDir, io, json);
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
