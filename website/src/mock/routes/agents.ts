/** Agent lifecycle, definitions, membership, and schedules. */
import { later } from "../activity";
import { publish } from "../bus";
import { isCron } from "../cron";
import { schedulesFor } from "../fixtures/agents";
import { decode, fail, ok, requireBody, route, type Route } from "../http";
import { ensureRoom, postMessage } from "../messages";
import { getState, update } from "../store";
import type { AgentDefinition, AgentInfo, AgentRecord, DemoState } from "../types";
import { workspaceFrom } from "./rooms";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function findAgent(name: string): AgentRecord {
	return getState().agents.find((agent) => agent.name === name) ?? fail(404, "not_found", `Unknown agent: ${name}`);
}

/**
 * An agent the daemon has a worker record for. A definition that has never
 * started has no account (the daemon lists it with `account: ""`), and the
 * daemon answers operations on it 404 like an unknown name.
 */
function findPeer(name: string): AgentRecord {
	const agent = findAgent(name);
	return agent.account === "" ? fail(404, "not_found", `Unknown agent: ${name}`) : agent;
}

function toInfo(agent: AgentRecord): AgentInfo & { model?: string } {
	const { definition } = agent;
	const automation =
		definition.wake?.rooms || definition.schedules?.length
			? { wakeRooms: definition.wake?.rooms === true, schedules: (definition.schedules ?? []).map((s) => s.cron) }
			: undefined;
	return {
		name: agent.name,
		state: agent.state,
		account: agent.account,
		...(definition.model?.[0] ? { model: definition.model[0] } : {}),
		...(agent.parent ? { parent: agent.parent } : {}),
		rooms: definition.rooms ?? [],
		...(automation ? { automation } : {}),
	};
}

function log(agent: AgentRecord, line: string): AgentRecord {
	return { ...agent, logs: [...agent.logs, `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-200) };
}

const withAgent = (name: string, change: (agent: AgentRecord) => AgentRecord) => (s: DemoState): DemoState => ({
	...s,
	agents: s.agents.map((a) => (a.name === name ? change(a) : a)),
});

/** Recompute one agent's schedule rows, keeping each row's pause switch. */
function refreshSchedules(name: string): void {
	update((s) => {
		const agent = s.agents.find((a) => a.name === name);
		if (!agent) return s;
		const previous = s.schedules.filter((row) => row.agent === name);
		return { ...s, schedules: [...s.schedules.filter((row) => row.agent !== name), ...schedulesFor(agent, Date.now(), previous)] };
	});
}

function roomList(value: unknown, field = "rooms"): string[] {
	if (!Array.isArray(value) || !value.every((room) => typeof room === "string" && /^[#@].+/.test(room)))
		fail(400, "invalid_definition", `${field}: must be a list of room ids starting with "#" or "@"`);
	return [...new Set(value as string[])];
}

/** Enough of the daemon's definition validator to refuse what it would refuse. */
function validateDefinition(patch: Record<string, unknown>): Partial<AgentDefinition> {
	const out: Record<string, unknown> = { ...patch };
	const text = (key: string) => {
		if (key in patch && (typeof patch[key] !== "string" || !(patch[key] as string).trim())) fail(400, "invalid_definition", `${key}: must be a non-empty string`);
	};
	text("description");
	text("body");
	if ("rooms" in patch) out.rooms = roomList(patch.rooms);
	if ("model" in patch && !(Array.isArray(patch.model) && patch.model.every((m) => typeof m === "string" && m.includes("/"))))
		fail(400, "invalid_definition", "model: must be a list of provider/model selectors");
	if ("spawns" in patch && patch.spawns !== "*" && !(Array.isArray(patch.spawns) && patch.spawns.every((s) => typeof s === "string")))
		fail(400, "invalid_definition", 'spawns: must be "*" or a list of agent names');
	if ("schedules" in patch) {
		const schedules = patch.schedules;
		if (!Array.isArray(schedules)) fail(400, "invalid_definition", "schedules: must be a list");
		(schedules as unknown[]).forEach((entry, index) => {
			const s = entry as Record<string, unknown>;
			if (typeof s?.cron !== "string" || !isCron(s.cron)) fail(400, "invalid_definition", `schedules[${index}].cron: not a five-field cron expression`);
			if (typeof s.prompt !== "string" || !s.prompt.trim()) fail(400, "invalid_definition", `schedules[${index}].prompt: is required`);
			if (s.room !== undefined && (typeof s.room !== "string" || !/^[#@].+/.test(s.room))) fail(400, "invalid_definition", `schedules[${index}].room: must start with "#" or "@"`);
		});
	}
	if ("workspace" in patch && patch.workspace !== undefined) out.workspace = workspaceFrom(patch.workspace);
	return out as Partial<AgentDefinition>;
}

function descendants(name: string, agents: AgentRecord[]): string[] {
	const found: string[] = [];
	const pending = [name];
	while (pending.length) {
		const parent = pending.shift();
		for (const agent of agents) {
			if (agent.parent !== parent || found.includes(agent.name)) continue;
			found.push(agent.name);
			pending.push(agent.name);
		}
	}
	return found;
}

export const agentRoutes: Route[] = [
	route("GET", /^\/api\/agents$/, () => ok({ agents: getState().agents.map(toInfo) })),

	route("POST", /^\/api\/agents$/, (ctx) => {
		const body = requireBody(ctx);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) fail(400, "invalid_request", "Agent name is required");
		if (!NAME.test(name)) fail(400, "invalid_request", `INVALID_NAME: ${name} must be letters, digits, dot, dash, or underscore`);
		if (typeof body.description !== "string" || !body.description.trim()) fail(400, "invalid_definition", "description: is required");
		if (typeof body.body !== "string" || !body.body.trim()) fail(400, "invalid_definition", "body: is required");
		if (getState().agents.some((agent) => agent.name === name)) fail(409, "conflict", `Agent ${name} already exists`);
		const { name: _name, ...rest } = body;
		const definition = { ...validateDefinition(rest), name } as AgentDefinition;
		for (const room of definition.rooms ?? []) ensureRoom(room);
		const agent: AgentRecord = { name, state: "stopped", account: "", definition, logs: [] };
		update((s) => ({ ...s, agents: [...s.agents, log(agent, "definition created by @you")] }));
		refreshSchedules(name);
		publish({ type: "agent", agent: name, state: "stopped" });
		return ok({ agent: { name, path: `/Users/you/.omp/agent/agents/${name}.md`, rooms: definition.rooms ?? [] }, rebuildRequired: true }, 201);
	}),

	route("POST", /^\/api\/agents\/([^/]+)\/start$/, (ctx) => {
		const name = decode(ctx.params[0]);
		const agent = findAgent(name);
		if (agent.state !== "stopped") fail(409, "conflict", `Agent ${name} is already running`);
		const inherited = new Set(
			(agent.definition.rooms ?? []).map((room) => getState().channels.find((c) => c.id === room)?.workspace).filter(Boolean),
		);
		if (!agent.definition.workspace && inherited.size > 1)
			fail(400, "invalid_request", `Agent ${name} belongs to channels with different workspaces; set its explicit workspace before Start`);
		const cwd = agent.definition.workspace ?? [...inherited][0] ?? "/Users/you/code/quarry";
		const account = agent.account || "durindoor";
		update(withAgent(name, (a) => log({ ...a, state: "running", account }, `worker started pid=${49000 + Math.floor(Math.random() * 900)} cwd=${cwd}`)));
		refreshSchedules(name);
		publish({ type: "agent", agent: name, state: "running" });
		publish({ type: "schedule", agent: name, phase: "armed" });
		const room = (agent.definition.rooms ?? []).find((r) => r.startsWith("#")) ?? agent.definition.rooms?.[0];
		if (room) {
			const waiting = getState().messages.filter((m) => m.room === room && (m.mentions ?? []).includes(name)).length;
			// Tracked with the other simulated turns, so a reset cancels it.
			later(1_500, () => {
				postMessage(room, name, waiting ? `Online. Reading ${waiting} message${waiting === 1 ? "" : "s"} that waited for me in ${room}.` : `Online in ${room}.`, null);
			});
		}
		return ok({ agent: toInfo(findAgent(name)) });
	}),

	route("POST", /^\/api\/agents\/([^/]+)\/kill$/, (ctx) => {
		const name = decode(ctx.params[0]);
		findPeer(name);
		const body = requireBody(ctx);
		if (body.keepChildren !== undefined && typeof body.keepChildren !== "boolean") fail(400, "invalid_request", "keepChildren must be a boolean when present");
		const keepChildren = body.keepChildren === true;
		const subtree = keepChildren ? [] : descendants(name, getState().agents);
		const stopped = new Set([name, ...subtree]);
		update((s) => ({
			...s,
			agents: s.agents.map((a) => {
				if (stopped.has(a.name)) return log({ ...a, state: "stopped" }, "stopped by @you");
				if (keepChildren && a.parent === name) {
					const { parent: _parent, ...root } = a;
					return log(root, `parent ${name} stopped; moved to root`);
				}
				return a;
			}),
			schedules: s.schedules.filter((row) => !(stopped.has(row.agent) && row.id.endsWith(":heartbeat"))),
		}));
		for (const agent of stopped) publish({ type: "agent", agent, state: "stopped" });
		return ok({ name, state: "stopped", keptChildren: keepChildren, cascaded: !keepChildren });
	}),

	route("POST", /^\/api\/agents\/([^/]+)\/inject$/, (ctx) => {
		const name = decode(ctx.params[0]);
		const agent = findPeer(name);
		const body = requireBody(ctx);
		const message = typeof body.message === "string" ? body.message.trim() : "";
		if (!message) fail(400, "invalid_request", "A message is required");
		// src/daemon/operations.ts: running takes the prompt now, parked gets it
		// posted to its first room for the next wake, stopped is refused.
		if (agent.state === "stopped") fail(400, "invalid_request", `Agent ${name} is stopped`);
		const queued = agent.state === "parked";
		if (queued) {
			const room = agent.definition.rooms?.[0] ?? fail(400, "invalid_request", `Agent ${name} subscribes to no room for queued injection`);
			ensureRoom(room);
			postMessage(room, "@you", message, null);
		}
		update(withAgent(name, (a) => log(a, `${queued ? "queued" : "injected"} steering from @you: ${message}`)));
		return ok({ name, queued });
	}),

	route("GET", /^\/api\/agents\/([^/]+)\/logs$/, (ctx) => {
		const name = decode(ctx.params[0]);
		const agent = findPeer(name);
		const raw = ctx.url.searchParams.get("lines");
		if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) === 0)) fail(400, "invalid_request", "lines must be a positive integer");
		return ok({ name, lines: agent.logs.slice(-(raw === null ? 50 : Number(raw))) });
	}),

	route("POST", /^\/api\/agents\/([^/]+)\/rooms$/, (ctx) => {
		const name = decode(ctx.params[0]);
		const agent = findAgent(name);
		const body = requireBody(ctx);
		const room = typeof body.room === "string" ? body.room.trim() : "";
		if (room.length < 2 || !/^[#@]/.test(room)) fail(400, "invalid_request", 'A room id starting with "#" or "@" is required');
		ensureRoom(room);
		const rooms = [...new Set([...(agent.definition.rooms ?? []), room])].sort();
		update(withAgent(name, (a) => log({ ...a, definition: { ...a.definition, rooms } }, `joined ${room}`)));
		publish({ type: "membership", agent: name, rooms });
		const live = agent.state !== "stopped";
		return ok({ rooms, rebuildRequired: false, notice: live ? "Membership took effect immediately." : "Membership saved. Messages wait in this room until the agent starts." });
	}),

	route("DELETE", /^\/api\/agents\/([^/]+)\/rooms\/([^/]+)$/, (ctx) => {
		const name = decode(ctx.params[0]);
		const room = decode(ctx.params[1]);
		const agent = findAgent(name);
		const rooms = (agent.definition.rooms ?? []).filter((r) => r !== room);
		update(withAgent(name, (a) => log({ ...a, definition: { ...a.definition, rooms } }, `left ${room}`)));
		publish({ type: "membership", agent: name, rooms });
		const live = agent.state !== "stopped";
		return ok({ rooms, rebuildRequired: false, notice: live ? "Membership took effect immediately." : "Membership saved. Messages wait in this room until the agent starts." });
	}),

	route("GET", /^\/api\/agents\/([^/]+)\/definition$/, (ctx) => {
		const agent = findAgent(decode(ctx.params[0]));
		return ok({ name: agent.name, filePath: `/Users/you/.omp/agent/agents/${agent.name}.md`, definition: agent.definition });
	}),

	route("PATCH", /^\/api\/agents\/([^/]+)$/, (ctx) => {
		const name = decode(ctx.params[0]);
		const agent = findAgent(name);
		const { name: submitted, ...patch } = requireBody(ctx);
		if (submitted !== undefined && submitted !== name) fail(400, "invalid_request", `An agent cannot be renamed through an edit: ${name} is immutable`);
		const changes = validateDefinition(patch);
		const definition = { ...agent.definition, ...changes, name } as AgentDefinition;
		for (const room of definition.rooms ?? []) ensureRoom(room);
		const { rooms: _a, ...before } = agent.definition;
		const { rooms: _b, ...after } = definition;
		const rebuildRequired = JSON.stringify(before) !== JSON.stringify(after);
		update(withAgent(name, (a) => log({ ...a, definition }, rebuildRequired ? "definition saved; rebuild on next turn" : "membership updated")));
		refreshSchedules(name);
		publish({ type: "definition", agent: name, rebuildRequired });
		if (JSON.stringify(agent.definition.rooms ?? []) !== JSON.stringify(definition.rooms ?? []))
			publish({ type: "membership", agent: name, rooms: definition.rooms ?? [] });
		return ok({
			agent: { name, path: `/Users/you/.omp/agent/agents/${name}.md`, rooms: definition.rooms ?? [] },
			rebuildRequired,
			notice: rebuildRequired
				? "Saved. The agent rebuilds on its next turn; the running session keeps the previous policy until then."
				: "Membership took effect immediately.",
		});
	}),

	route("GET", /^\/api\/schedules$/, () => ok({ schedules: getState().schedules })),

	route("PATCH", /^\/api\/schedules\/([^/]+)$/, (ctx) => {
		const id = decode(ctx.params[0]);
		const body = requireBody(ctx);
		if (typeof body.enabled !== "boolean") fail(400, "invalid_request", "enabled must be a boolean");
		const row = getState().schedules.find((r) => r.id === id) ?? fail(404, "not_found", `Unknown schedule: ${id}`);
		const schedule = { ...row, enabled: body.enabled as boolean };
		update((s) => ({ ...s, schedules: s.schedules.map((r) => (r.id === id ? schedule : r)) }));
		publish({ type: "schedule", agent: row.agent, phase: "armed" });
		return ok({ schedule });
	}),
];
