/**
 * Purpose: Slash-command logic for the T-504 operator surface — `/agents`,
 * `/spawn`, `/kill`, `/rooms`, `/schedule`. Each command is a plain exported
 * function over two thin seams (`DaemonClient`, `ExtensionIO`), so the test
 * suite drives them against the real protocol server without OMP running.
 *
 * Public API: `DaemonClient`, `DaemonUnavailableError`, `ExtensionIO`, and
 * one exported function per command.
 *
 * Upstream deps: `../shared/protocol` (wire shapes), `./widget`
 * (`createDaemonClient`, `DAEMON_UNAVAILABLE`).
 *
 * Downstream consumers: `./index`, which adapts these onto OMP's
 * `ExtensionAPI`; `tests/extension.test.ts`.
 *
 * Failure modes: a missing daemon surfaces as one clear notice, never a
 * stack trace; a protocol-level refusal (unknown peer, unknown schedule)
 * lands as the server's message. Destructive kills confirm through
 * `ExtensionIO.confirm` before the wire call.
 *
 * Performance: one socket round trip per command; `/agents` reuses the
 * `agent_status` listing, so no N+1.
 */
import type {
	AgentSpawnResult,
	AgentStatus,
	ChatReadResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	KillResult,
	MethodName,
	RoomsPostResult,
	SchedulesArmResult,
	SchedulesListResult,
} from "../shared/protocol";
import { DAEMON_UNAVAILABLE } from "./widget";

/**
 * The slice of the daemon wire the commands need. `createDaemonClient` in
 * `./widget` implements it over the unix socket; tests pass the same client.
 */
export interface DaemonClient {
	call<T>(method: MethodName, params?: unknown): Promise<T>;
}

/** The OMP-side seam: what a command may show or ask the operator. */
export interface ExtensionIO {
	notify(message: string): void;
	setWidget(key: string, lines: string[]): void;
	/** Ask-dialog confirmation; resolves false on decline or dismiss. */
	confirm(title: string, message: string): Promise<boolean>;
}

/** Raised by the client when the socket is absent; handled as data. */
export class DaemonUnavailableError extends Error {
	constructor() {
		super(DAEMON_UNAVAILABLE);
		this.name = "DaemonUnavailableError";
	}
}

/**
 * The shield marks a real OS sandbox (ADR-005). The production wire type
 * predates the flag, so a daemon that never sets it — or sets it false —
 * renders no shield: claiming a sandbox the worker does not run under is a
 * false security claim, worse than no marker.
 */
function shield(agent: AgentStatus & { sandboxed?: boolean }): string {
	return agent.sandboxed === true ? "🛡 " : "";
}

function formatAgent(agent: AgentStatus & { sandboxed?: boolean }): string {
	const model = agent.model === undefined ? "" : ` ${agent.model}`;
	return `${shield(agent)}${agent.name} — ${agent.state} (${agent.account})${model}`;
}

/**
 * Run `body`, answering one clear notice when the daemon is absent and the
 * server's message when the protocol refuses. Nothing here may throw into
 * the TUI.
 */
async function guard(
	io: ExtensionIO,
	body: () => Promise<void>,
): Promise<void> {
	try {
		await body();
	} catch (error) {
		if (error instanceof DaemonUnavailableError) {
			io.notify(DAEMON_UNAVAILABLE);
			return;
		}
		io.notify(error instanceof Error ? error.message : String(error));
	}
}

/** `/agents` — live peer list from the daemon. */
export async function agentsCommand(
	client: DaemonClient,
	io: ExtensionIO,
	_args: string,
): Promise<void> {
	await guard(io, async () => {
		const { agents } = await client.call<{ agents: AgentStatus[] }>(
			"agent_status",
			{},
		);
		io.notify(
			agents.length === 0
				? "No agents registered."
				: agents.map(formatAgent).join("\n"),
		);
	});
}

/** `/spawn <name>` — start a peer from its definition. */
export async function spawnCommand(
	client: DaemonClient,
	io: ExtensionIO,
	name: string,
): Promise<void> {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		io.notify("usage: /spawn <peer-name>");
		return;
	}
	await guard(io, async () => {
		const result = await client.call<AgentSpawnResult>("agent_spawn", {
			name: trimmed,
		});
		io.notify(`spawned ${result.name} — ${result.state}`);
	});
}

/** `/kill <name>` — confirm, then stop the worker. */
export async function killCommand(
	client: DaemonClient,
	io: ExtensionIO,
	name: string,
): Promise<void> {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		io.notify("usage: /kill <peer-name>");
		return;
	}
	const confirmed = await io.confirm(
		"Kill agent",
		`Kill ${trimmed}? Its worker stops and parked work waits for a respawn.`,
	);
	if (!confirmed) {
		io.notify(`kept ${trimmed}`);
		return;
	}
	await guard(io, async () => {
		const result = await client.call<KillResult>("kill", { name: trimmed });
		io.notify(`killed ${result.name}`);
	});
}

/** `/rooms read <room>` — render the transcript. */
export async function roomsReadCommand(
	client: DaemonClient,
	io: ExtensionIO,
	room: string,
): Promise<void> {
	await guard(io, async () => {
		const { messages } = await client.call<ChatReadResult>("chat_read", {
			room,
			limit: 50,
		});
		io.notify(
			messages.length === 0
				? `${room}: no messages yet.`
				: messages
						.map((message) => `${message.author}: ${message.body}`)
						.join("\n"),
		);
	});
}

/** `/rooms post <room> <body>` — post as the human operator. */
export async function roomsPostCommand(
	client: DaemonClient,
	io: ExtensionIO,
	room: string,
	body: string,
): Promise<void> {
	if (body.trim().length === 0) {
		io.notify("usage: /rooms post <room> <message>");
		return;
	}
	await guard(io, async () => {
		const result = await client.call<RoomsPostResult>("rooms_post", {
			room,
			body,
		});
		io.notify(`posted to ${room} as @you (message ${result.messageId})`);
	});
}

/** `/schedule` — list armed schedules. */
export async function scheduleListCommand(
	client: DaemonClient,
	io: ExtensionIO,
	_args: string,
): Promise<void> {
	await guard(io, async () => {
		const { schedules } = await client.call<SchedulesListResult>(
			"schedules_list",
			{},
		);
		io.notify(
			schedules.length === 0
				? "No schedules armed."
				: schedules
						.map(
							(schedule) =>
								`${schedule.id} — ${schedule.cron ?? "automation"} — ${schedule.enabled ? "enabled" : "disabled"} — ${schedule.action}`,
						)
						.join("\n"),
		);
	});
}

/** `/schedule <id> on|off` — arm or disarm one schedule. */
export async function scheduleArmCommand(
	client: DaemonClient,
	io: ExtensionIO,
	args: string,
): Promise<void> {
	const [id, verb] = args.trim().split(/\s+/);
	if (!id || (verb !== "on" && verb !== "off")) {
		io.notify("usage: /schedule <id> on|off");
		return;
	}
	await guard(io, async () => {
		const { schedule } = await client.call<SchedulesArmResult>(
			"schedules_arm",
			{ scheduleId: id, enabled: verb === "on" },
		);
		io.notify(`${schedule.id} ${schedule.enabled ? "enabled" : "disabled"}`);
	});
}

/** Exported for tests: the frame union a raw round trip returns. */
export type { JsonRpcFailure, JsonRpcSuccess };
