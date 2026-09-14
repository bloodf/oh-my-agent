/** Capabilities, catalogs, artifacts, profile, and the remote-auth handshakes. */
import { publish } from "../bus";
import { MODELS, PRESETS } from "../fixtures/agents";
import { fail, ok, requireBody, route, type Route } from "../http";
import { getState, update } from "../store";
import type { Persona, Profile } from "../types";

const MAX_NAME = 40;
const MAX_AVATAR = 4;

function persona(value: unknown, at: string): Persona {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
	const out: Persona = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "displayName" && key !== "avatar") throw new Error(`${at}.${key} is not a profile field`);
		if (entry === undefined || entry === null || entry === "") continue;
		if (typeof entry !== "string") throw new Error(`${at}.${key} must be a string`);
		const text = entry.trim();
		const limit = key === "avatar" ? MAX_AVATAR : MAX_NAME;
		const length = [...new Intl.Segmenter().segment(text)].length;
		if (length === 0 || length > limit) throw new Error(`${at}.${key} must be 1 to ${limit} characters`);
		out[key] = text;
	}
	return out;
}

/** Same merge rules as the daemon's profile store. */
function mergeProfile(current: Profile, patch: Record<string, unknown>): Profile {
	const next: Profile = { operator: { ...current.operator }, agents: { ...current.agents } };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "operator") next.operator = persona(value, "operator");
		else if (key === "agents") {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("agents must be an object");
			for (const [name, entry] of Object.entries(value)) {
				if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error(`agents.${name} is not an agent name`);
				const p = persona(entry, `agents.${name}`);
				if (Object.keys(p).length === 0) {
					const { [name]: _removed, ...rest } = next.agents;
					next.agents = rest;
				} else next.agents = { ...next.agents, [name]: p };
			}
		} else throw new Error(`${key} is not a profile field`);
	}
	return next;
}

const ticket = () => `demo-${Math.random().toString(36).slice(2, 14)}`;

export const systemRoutes: Route[] = [
	route("GET", /^\/api\/capabilities$/, () => ok({ fullControl: true })),
	route("GET", /^\/api\/models$/, () => ok(MODELS)),
	route("GET", /^\/api\/presets$/, () => ok({ presets: PRESETS })),

	route("GET", /^\/api\/artifacts$/, () => ok({ artifacts: getState().artifacts })),
	route("POST", /^\/api\/artifacts$/, (ctx) => {
		const file = typeof ctx.body?.file === "string" ? ctx.body.file : "";
		if (!file.startsWith("/") || !/\.html?$/i.test(file)) fail(400, "invalid_request", "file must be an absolute .html path");
		const row = getState().artifacts.find((a) => a.file === file) ?? fail(404, "not_found", `No Lavish session for ${file}`);
		const artifact = { ...row, status: row.status === "closed" ? "open" : row.status, updatedAt: new Date().toISOString() };
		update((s) => ({ ...s, artifacts: s.artifacts.map((a) => (a.file === file ? artifact : a)) }));
		return ok({ artifact });
	}),

	route("GET", /^\/api\/profile$/, () => ok({ profile: getState().profile })),
	route("PUT", /^\/api\/profile$/, (ctx) => {
		const body = requireBody(ctx);
		let profile: Profile;
		try {
			profile = mergeProfile(getState().profile, body);
		} catch (error) {
			return fail(400, "invalid_request", error instanceof Error ? error.message : String(error));
		}
		update((s) => ({ ...s, profile }));
		publish({ type: "profile" });
		return ok({ profile });
	}),

	// Remote-mode handshakes. The demo runs loopback mode, but answers them faithfully.
	route("POST", /^\/api\/session$/, () => ok({ ticket: ticket() })),
	route("POST", /^\/api\/ws-ticket$/, () => ok({ ticket: ticket() })),
];
