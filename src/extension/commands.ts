/**
 * Purpose: Slash-command logic for the T-504/T-511/T-903 operator surface —
 * peer, room, schedule, log-tail, instruction-injection, and definition/model
 * editing commands. Each command is a plain exported function over two thin
 * seams (`DaemonClient`, `ExtensionIO`), so the test suite drives them against
 * the real protocol server without OMP running.
 *
 * Public API: `DaemonClient`, `DaemonUnavailableError`, `ExtensionIO`, and
 * one exported function per command.
 *
 * Upstream deps: `../shared/protocol` (wire shapes),
 * `../shared/agent-definition` (edit validation), `../daemon/peer-store`
 * (canonical markdown rendering), `./widget` (daemon availability).
 *
 * Downstream consumers: `./index`, which adapts these onto OMP's
 * `ExtensionAPI`; `tests/extension.test.ts`.
 *
 * Failure modes: a missing daemon surfaces as one clear notice, never a
 * stack trace; a protocol-level refusal lands as the server's message.
 * Definition refusals reopen the editor with the rejected text intact.
 * Destructive kills confirm through `ExtensionIO.confirm` before the wire call.
 *
 * Performance: one socket round trip per command; `/agents` reuses the
 * `agent_status` listing, so no N+1.
 */
import { renderPeerDefinition } from "../daemon/peer-store";
import { parsePeerDefinition } from "../shared/agent-definition";
import type {
	AgentSpawnResult,
	AgentStatus,
	AgentStatusResult,
	ChatReadResult,
	DefinitionData,
	DefinitionGetResult,
	DefinitionUpdateResult,
	InjectResult,
	JsonRpcFailure,
	JsonRpcSuccess,
	KillResult,
	LogsTailResult,
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
	/** Single-choice selection; resolves undefined on cancel/Esc. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Multi-line editor; resolves undefined on cancel/Esc. */
	editor?(title: string, prefill?: string): Promise<string | undefined>;
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

function formatAgent(
	agent: AgentStatus & { orphaned?: boolean; sandboxed?: boolean },
	depth = 0,
	orphan = false,
): string {
	const model = agent.model === undefined ? "" : ` ${agent.model}`;
	const suffix =
		orphan || agent.orphaned === true
			? ` (orphan: ${agent.parent ?? "missing-parent"})`
			: "";
	return `${"  ".repeat(depth)}${shield(agent)}${agent.name} — ${agent.state} (${agent.account})${model}${suffix}`;
}

function formatAgentTree(agents: AgentStatus[]): string {
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const children = new Map<string, Set<string>>();
	for (const agent of agents) {
		if (agent.parent !== undefined && byName.has(agent.parent)) {
			(
				children.get(agent.parent) ??
				children.set(agent.parent, new Set()).get(agent.parent)
			)?.add(agent.name);
		}
		for (const child of agent.children ?? []) {
			if (byName.has(child)) {
				(
					children.get(agent.name) ??
					children.set(agent.name, new Set()).get(agent.name)
				)?.add(child);
			}
		}
	}

	const rendered = new Set<string>();
	const lines: string[] = [];
	const render = (name: string, depth: number): void => {
		if (rendered.has(name)) return;
		rendered.add(name);
		const agent = byName.get(name);
		if (agent === undefined) return;
		lines.push(
			formatAgent(
				agent,
				depth,
				agent.parent !== undefined && !byName.has(agent.parent),
			),
		);
		for (const child of [...(children.get(name) ?? [])].sort())
			render(child, depth + 1);
	};
	const roots = agents
		.filter((agent) => agent.parent === undefined || !byName.has(agent.parent))
		.map((agent) => agent.name)
		.sort();
	for (const root of roots) render(root, 0);
	for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name)))
		render(agent.name, 0);
	return lines.join("\n");
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
			agents.length === 0 ? "No agents registered." : formatAgentTree(agents),
		);
	});
}

const EDITABLE_DEFINITION_KEYS = [
	"description",
	"model",
	"tools",
	"spawns",
	"thinkingLevel",
	"output",
	"blocking",
	"autoloadSkills",
	"readSummarize",
	"prewalk",
	"advisor",
	"body",
	"workspace",
	"rooms",
	"wake",
	"autonomy",
	"sandbox",
	"mcps",
	"skills",
	"schedules",
	"automations",
] as const satisfies readonly (keyof DefinitionData)[];

const FREE_MODEL = "Enter another model…";

function updateMessage(result: DefinitionUpdateResult): string {
	return result.rebuildRequired
		? `Updated ${result.name} (rebuildRequired: true); next delivery rebuilds the worker.`
		: `Updated ${result.name} (rebuildRequired: false).`;
}

function editableChanges(definition: DefinitionData): Partial<DefinitionData> {
	const changes: Partial<DefinitionData> = {};
	for (const key of EDITABLE_DEFINITION_KEYS) {
		const value = definition[key];
		if (value !== undefined) Object.assign(changes, { [key]: value });
	}
	return changes;
}

function removedEditableField(
	before: DefinitionData,
	after: DefinitionData,
): string | undefined {
	for (const key of EDITABLE_DEFINITION_KEYS) {
		if (key !== "body" && before[key] !== undefined && after[key] === undefined)
			return key;
	}
	return undefined;
}

async function editDefinition(
	client: DaemonClient,
	io: ExtensionIO,
	fetched: DefinitionGetResult,
): Promise<string | undefined> {
	if (io.editor === undefined) return "Editor unavailable in this mode.";
	let draft = renderPeerDefinition({
		...editableChanges(fetched.definition),
		name: fetched.name,
		body: fetched.definition.body,
	});
	let title = `Edit definition: ${fetched.name}`;
	for (;;) {
		const submitted = await io.editor(title, draft);
		if (submitted === undefined) return undefined;
		draft = submitted;
		try {
			const parsed = parsePeerDefinition(fetched.filePath, submitted);
			if (parsed.name !== fetched.name) {
				throw new Error(`name must remain ${fetched.name}`);
			}
			const removed = removedEditableField(fetched.definition, parsed);
			if (removed !== undefined) {
				throw new Error(
					`removing ${removed} is not supported by definition_update`,
				);
			}
			const result = await client.call<DefinitionUpdateResult>(
				"definition_update",
				{ name: fetched.name, changes: editableChanges(parsed) },
			);
			return updateMessage(result);
		} catch (error) {
			title = `Fix definition: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

async function editModel(
	client: DaemonClient,
	io: ExtensionIO,
	fetched: DefinitionGetResult,
): Promise<string | undefined> {
	const configured = Array.isArray(fetched.definition.model)
		? fetched.definition.model
		: [];
	const selected = await io.select(`Model for ${fetched.name}`, [
		...configured,
		FREE_MODEL,
	]);
	if (selected === undefined) return undefined;
	const model =
		selected === FREE_MODEL
			? io.editor === undefined
				? undefined
				: await io.editor(`Model for ${fetched.name}`, configured[0] ?? "")
			: selected;
	if (model === undefined || model.trim().length === 0) return undefined;
	const result = await client.call<DefinitionUpdateResult>(
		"definition_update",
		{
			name: fetched.name,
			changes: { model: [model.trim()] },
		},
	);
	return updateMessage(result);
}

/** `/edit <name>` — edit a definition document or choose its model. */
export async function editCommand(
	client: DaemonClient,
	io: ExtensionIO,
	name: string,
): Promise<string | undefined> {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		const usage = "usage: /edit <peer-name>";
		io.notify(usage);
		return usage;
	}
	try {
		const fetched = await client.call<DefinitionGetResult>("definition_get", {
			name: trimmed,
		});
		const kind = await io.select(`Edit ${trimmed}`, ["Definition", "Model"]);
		const message =
			kind === "Definition"
				? await editDefinition(client, io, fetched)
				: kind === "Model"
					? await editModel(client, io, fetched)
					: undefined;
		if (message !== undefined) io.notify(message);
		return message;
	} catch (error) {
		const message =
			error instanceof DaemonUnavailableError
				? DAEMON_UNAVAILABLE
				: error instanceof Error
					? error.message
					: String(error);
		io.notify(message);
		return message;
	}
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
		// Hierarchy (ADR-011): an optional parent picker over live peers; the
		// choice is cooperative metadata, and cancel means a root spawn.
		let parent: string | undefined;
		const status = await client.call<AgentStatusResult>("agent_status", {});
		const live = status.agents
			.filter((agent) => agent.state !== "stopped")
			.map((agent) => agent.name);
		if (live.length > 0 && io.select) {
			const chosen = await io.select(
				"Parent for the new peer (Esc = root)",
				live,
			);
			parent = chosen;
		}
		const result = await client.call<AgentSpawnResult>("agent_spawn", {
			name: trimmed,
			...(parent === undefined ? {} : { parent }),
		});
		io.notify(
			`spawned ${result.name} — ${result.state}${parent ? ` under ${parent}` : ""}`,
		);
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

/** `/logs <name> [n]` — print the worker's buffered output tail. */
export async function logsCommand(
	client: DaemonClient,
	io: ExtensionIO,
	args: string,
): Promise<void> {
	const [name, count, ...extra] = args.trim().split(/\s+/);
	const lines = count === undefined ? 50 : Number(count);
	if (!name || extra.length > 0 || !Number.isSafeInteger(lines) || lines <= 0) {
		io.notify("usage: /logs <peer-name> [line-count]");
		return;
	}
	await guard(io, async () => {
		const result = await client.call<LogsTailResult>("logs_tail", {
			name,
			lines,
		});
		io.notify(
			result.lines.length === 0
				? `${result.name}: no buffered output.`
				: result.lines.join("\n"),
		);
	});
}

/** `/inject <name> <message>` — deliver now or queue for the next turn. */
export async function injectCommand(
	client: DaemonClient,
	io: ExtensionIO,
	args: string,
): Promise<void> {
	const [name, ...words] = args.trim().split(/\s+/);
	const message = words.join(" ");
	if (!name || message.length === 0) {
		io.notify("usage: /inject <peer-name> <message>");
		return;
	}
	await guard(io, async () => {
		const result = await client.call<InjectResult>("inject", { name, message });
		io.notify(
			result.queued
				? `queued instruction for ${result.name}`
				: `delivered instruction to ${result.name}`,
		);
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
