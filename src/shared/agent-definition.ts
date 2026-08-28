/**
 * Purpose: Parse oh-my-agent peer definitions (markdown + YAML frontmatter) into
 *          typed PeerDefinition records. Delegates native OMP fields to pi-coding-agent
 *          parseAgent; validates oh-my-agent extensions (workspace, rooms, wake,
 *          autonomy, sandbox, mcps, skills, schedules, automations) with strict nested
 *          key and type checks. Computes a stable canonical SHA-256 fingerprint.
 *
 * Public API: parsePeerDefinition(filePath, content), fingerprintPeerDefinition(def)
 *
 * Upstream deps:
 *   OMP parseAgent      — @oh-my-pi/pi-coding-agent/task/agents (native fields, fatal)
 *   pi-utils            — @oh-my-pi/pi-utils frontmatter (extras, fatal, normalized)
 *   node crypto/path    — createHash (fingerprint), isAbsolute (path validation)
 *
 * Downstream consumers: materializer, daemon
 *
 * Failure modes:
 *   PeerParsingError codes:
 *     MISSING_SPAWNS   — spawns absent
 *     EMPTY_SPAWNS     — spawns present but empty
 *     EMPTY_BODY       — body absent or whitespace-only
 *     UNKNOWN_KEY      — unrecognized top-level or nested key
 *     INVALID_WORKSPACE — workspace not a string or not absolute path
 *     INVALID_ROOM     — rooms not string array or entry missing #/@ prefix
 *     INVALID_WAKE     — wake not a plain object or contains unknown/typed fields
 *     INVALID_AUTONOMY — autonomy not a plain object, unknown keys, non-positive values
 *     INVALID_SANDBOX  — sandbox not boolean or not a plain object with unknown keys
 *     INVALID_ARRAY    — mcps/skills not string arrays
 *     INVALID_SCHEDULE — schedule item missing cron/prompt or not non-empty strings
 *     INVALID_AUTOMATION — automation item missing event/prompt or invalid room
 *     INVALID_TYPE     — spawns wrong type (not string or array)
 *   OMP parseAgent throws AgentParsingError on malformed YAML or invalid native fields
 *   — all are pure/safe to retry after user correction
 *
 * Performance: sync parse + hash; linear in document size
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

// ── Allowed key sets ────────────────────────────────────────────────────────────

const NATIVE_KEYS = new Set([
	"name",
	"description",
	"model",
	"tools",
	"spawns",
	"thinking",
	"thinkingLevel",
	"output",
	"blocking",
	"autoloadSkills",
	"readSummarize",
	"prewalk",
	"advisor",
]);

const EXTRA_KEYS = new Set([
	"workspace",
	"rooms",
	"wake",
	"autonomy",
	"sandbox",
	"mcps",
	"skills",
	"schedules",
	"automations",
]);

// ── Errors ────────────────────────────────────────────────────────────────────

export class PeerParsingError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly filePath?: string,
	) {
		super(message);
		this.name = "PeerParsingError";
	}
}

// ── Extras types ───────────────────────────────────────────────────────────────

export interface Schedule {
	cron: string;
	prompt: string;
	room?: string;
}

export interface Automation {
	event: string;
	prompt: string;
	room?: string;
}

export interface WakeConfig {
	mention?: boolean;
	rooms?: boolean;
	[key: string]: unknown;
}

export interface AutonomyConfig {
	maxTurns?: number;
	budgetUsd?: number;
	[key: string]: unknown;
}

export interface SandboxConfig {
	enabled?: boolean;
	extraRoots?: string[];
	[key: string]: unknown;
}

// ── PeerDefinition ─────────────────────────────────────────────────────────────

export interface PeerDefinition
	extends Omit<
		AgentDefinition,
		"spawns" | "filePath" | "source" | "systemPrompt"
	> {
	spawns: string[] | "*";
	body: string;
	workspace?: string;
	rooms?: string[];
	wake?: WakeConfig;
	autonomy?: AutonomyConfig;
	sandbox?: SandboxConfig | boolean;
	mcps?: string[];
	skills?: string[];
	schedules?: Schedule[];
	automations?: Automation[];
	sha256: string;
}

// ── Structural helpers ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return (
		v !== null &&
		typeof v === "object" &&
		!Array.isArray(v) &&
		!(v instanceof Date)
	);
}

function validateNestedKeys(
	obj: Record<string, unknown>,
	allowed: Set<string>,
	parentKey: string,
): void {
	for (const k of Object.keys(obj)) {
		if (!allowed.has(k)) {
			throw new PeerParsingError(
				`Unknown key: "${parentKey}.${k}"`,
				"UNKNOWN_KEY",
			);
		}
	}
}

// ── Top-level extras validator ─────────────────────────────────────────────────

function validateExtras(fm: Record<string, unknown>): void {
	for (const key of Object.keys(fm)) {
		if (NATIVE_KEYS.has(key)) continue;
		if (!EXTRA_KEYS.has(key)) {
			throw new PeerParsingError(`Unknown key: "${key}"`, "UNKNOWN_KEY");
		}

		const val = fm[key];

		if (key === "workspace") {
			if (typeof val !== "string") {
				throw new PeerParsingError(
					`workspace must be a string, got: ${typeof val}`,
					"INVALID_WORKSPACE",
				);
			}
			if (!isAbsolute(val)) {
				throw new PeerParsingError(
					`workspace must be absolute, got: ${val}`,
					"INVALID_WORKSPACE",
				);
			}
		}

		if (key === "rooms") {
			if (!Array.isArray(val)) {
				throw new PeerParsingError(
					`rooms must be a string array, got: ${typeof val}`,
					"INVALID_ROOM",
				);
			}
			for (const r of val) {
				if (typeof r !== "string") {
					throw new PeerParsingError(
						`rooms must be a string array, got: ${typeof r}`,
						"INVALID_ROOM",
					);
				}
				if (!r.startsWith("#") && !r.startsWith("@")) {
					throw new PeerParsingError(
						`rooms entries must start with "#" or "@", got: ${r}`,
						"INVALID_ROOM",
					);
				}
			}
		}

		if (key === "wake") {
			if (!isPlainObject(val)) {
				throw new PeerParsingError(
					`wake must be a plain object, got: ${Array.isArray(val) ? "array" : typeof val}`,
					"INVALID_WAKE",
				);
			}
			validateNestedKeys(val, new Set(["mention", "rooms"]), "wake");
			const { mention, rooms: roomsFlag } = val;
			if (mention !== undefined && typeof mention !== "boolean") {
				throw new PeerParsingError(
					`wake.mention must be boolean, got: ${typeof mention}`,
					"INVALID_WAKE",
				);
			}
			if (roomsFlag !== undefined && typeof roomsFlag !== "boolean") {
				throw new PeerParsingError(
					`wake.rooms must be boolean, got: ${typeof roomsFlag}`,
					"INVALID_WAKE",
				);
			}
		}

		if (key === "autonomy") {
			if (!isPlainObject(val)) {
				throw new PeerParsingError(
					`autonomy must be a plain object, got: ${Array.isArray(val) ? "array" : typeof val}`,
					"INVALID_AUTONOMY",
				);
			}
			validateNestedKeys(val, new Set(["maxTurns", "budgetUsd"]), "autonomy");
			const { maxTurns, budgetUsd } = val;
			if (maxTurns !== undefined) {
				if (
					typeof maxTurns !== "number" ||
					!Number.isInteger(maxTurns) ||
					maxTurns < 1
				) {
					throw new PeerParsingError(
						`autonomy.maxTurns must be a positive integer, got: ${maxTurns}`,
						"INVALID_AUTONOMY",
					);
				}
			}
			if (budgetUsd !== undefined) {
				if (
					typeof budgetUsd !== "number" ||
					!Number.isFinite(budgetUsd) ||
					budgetUsd <= 0
				) {
					throw new PeerParsingError(
						`autonomy.budgetUsd must be a positive finite number, got: ${budgetUsd}`,
						"INVALID_AUTONOMY",
					);
				}
			}
		}

		if (key === "sandbox") {
			if (typeof val === "boolean") continue;
			if (!isPlainObject(val)) {
				throw new PeerParsingError(
					`sandbox must be a boolean or plain object, got: ${typeof val}`,
					"INVALID_SANDBOX",
				);
			}
			validateNestedKeys(val, new Set(["enabled", "extraRoots"]), "sandbox");
			const { enabled, extraRoots } = val;
			if (enabled !== undefined && typeof enabled !== "boolean") {
				throw new PeerParsingError(
					`sandbox.enabled must be boolean, got: ${typeof enabled}`,
					"INVALID_SANDBOX",
				);
			}
			if (extraRoots !== undefined) {
				if (!Array.isArray(extraRoots)) {
					throw new PeerParsingError(
						`sandbox.extraRoots must be a string array, got: ${typeof extraRoots}`,
						"INVALID_SANDBOX",
					);
				}
				for (const r of extraRoots) {
					if (typeof r !== "string") {
						throw new PeerParsingError(
							`sandbox.extraRoots must be a string array, got: ${typeof r}`,
							"INVALID_SANDBOX",
						);
					}
					if (!isAbsolute(r)) {
						throw new PeerParsingError(
							`sandbox.extraRoots entries must be absolute, got: ${r}`,
							"INVALID_WORKSPACE",
						);
					}
				}
			}
		}

		if (key === "mcps" || key === "skills") {
			if (!Array.isArray(val)) {
				throw new PeerParsingError(
					`${key} must be a string array, got: ${typeof val}`,
					"INVALID_ARRAY",
				);
			}
			for (const item of val) {
				if (typeof item !== "string") {
					throw new PeerParsingError(
						`${key} must be a string array, got: ${typeof item}`,
						"INVALID_ARRAY",
					);
				}
			}
		}

		if (key === "schedules") {
			if (!Array.isArray(val)) {
				throw new PeerParsingError(
					`schedules must be an array, got: ${typeof val}`,
					"INVALID_SCHEDULE",
				);
			}
			for (let i = 0; i < val.length; i++) {
				const s = val[i];
				if (!isPlainObject(s)) {
					throw new PeerParsingError(
						`schedules[${i}] must be a plain object, got: ${typeof s}`,
						"INVALID_SCHEDULE",
					);
				}
				validateNestedKeys(
					s,
					new Set(["cron", "prompt", "room"]),
					`schedules[${i}]`,
				);
				const { cron, prompt, room } = s as Record<string, unknown>;
				if (typeof cron !== "string" || cron.trim().length === 0) {
					throw new PeerParsingError(
						`schedules[${i}].cron must be a non-empty string, got: ${cron}`,
						"INVALID_SCHEDULE",
					);
				}
				if (typeof prompt !== "string" || prompt.trim().length === 0) {
					throw new PeerParsingError(
						`schedules[${i}].prompt must be a non-empty string, got: ${prompt}`,
						"INVALID_SCHEDULE",
					);
				}
				if (room !== undefined) {
					if (
						typeof room !== "string" ||
						(!room.startsWith("#") && !room.startsWith("@"))
					) {
						throw new PeerParsingError(
							`schedules[${i}].room must start with "#" or "@", got: ${room}`,
							"INVALID_ROOM",
						);
					}
				}
			}
		}

		if (key === "automations") {
			if (!Array.isArray(val)) {
				throw new PeerParsingError(
					`automations must be an array, got: ${typeof val}`,
					"INVALID_AUTOMATION",
				);
			}
			for (let i = 0; i < val.length; i++) {
				const a = val[i];
				if (!isPlainObject(a)) {
					throw new PeerParsingError(
						`automations[${i}] must be a plain object, got: ${typeof a}`,
						"INVALID_AUTOMATION",
					);
				}
				validateNestedKeys(
					a,
					new Set(["event", "prompt", "room"]),
					`automations[${i}]`,
				);
				const { event, prompt, room } = a as Record<string, unknown>;
				if (typeof event !== "string" || event.trim().length === 0) {
					throw new PeerParsingError(
						`automations[${i}].event must be a non-empty string, got: ${event}`,
						"INVALID_AUTOMATION",
					);
				}
				if (typeof prompt !== "string" || prompt.trim().length === 0) {
					throw new PeerParsingError(
						`automations[${i}].prompt must be a non-empty string, got: ${prompt}`,
						"INVALID_AUTOMATION",
					);
				}
				if (room !== undefined) {
					if (
						typeof room !== "string" ||
						(!room.startsWith("#") && !room.startsWith("@"))
					) {
						throw new PeerParsingError(
							`automations[${i}].room must start with "#" or "@", got: ${room}`,
							"INVALID_ROOM",
						);
					}
				}
			}
		}
	}
}

// ── Sync SHA-256 fingerprint ────────────────────────────────────────────────────

function computeFingerprint(def: PeerDefinition): string {
	const record = def as unknown as Record<string, unknown>;
	const sig: Record<string, unknown> = {};
	const keys = [
		"name",
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
		"workspace",
		"rooms",
		"wake",
		"autonomy",
		"sandbox",
		"mcps",
		"skills",
		"schedules",
		"automations",
		"body",
	];
	for (const k of keys) {
		const v = record[k];
		if (v !== undefined) sig[k] = sortCanonical(v);
	}
	return createHash("sha256").update(JSON.stringify(sig)).digest("hex");
}

function sortCanonical(v: unknown): unknown {
	if (v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return (v as unknown[]).map(sortCanonical);
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(v as Record<string, unknown>).sort()) {
		sorted[k] = sortCanonical((v as Record<string, unknown>)[k]);
	}
	return sorted;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parsePeerDefinition(
	filePath: string,
	content: string,
): PeerDefinition {
	// Native fields via OMP parseAgent (fatal)
	const agent = parseAgent(filePath, content, "user", "fatal");

	// Extras via pi-utils parseFrontmatter (fatal, normalized)
	const { frontmatter: rawFm, body } = parseFrontmatter(content, {
		location: filePath,
		level: "fatal",
		normalize: true,
	});

	// Validate extras
	validateExtras(rawFm);

	// Spawns: inspect rawFm first — allowed exactly "*", nonempty string/CSV, or array of strings.
	// Invalid types reject before MISSING/EMPTY.
	const rawSpawns = rawFm.spawns;
	if (rawSpawns === undefined) {
		throw new PeerParsingError(
			"Missing required field: spawns",
			"MISSING_SPAWNS",
			filePath,
		);
	}
	if (typeof rawSpawns === "string") {
		if (rawSpawns.trim().length === 0) {
			throw new PeerParsingError(
				"spawns cannot be empty",
				"EMPTY_SPAWNS",
				filePath,
			);
		}
		// Single "*" or CSV — native handles CSV normalization
	} else if (Array.isArray(rawSpawns)) {
		if (rawSpawns.length === 0) {
			throw new PeerParsingError(
				"spawns cannot be empty",
				"EMPTY_SPAWNS",
				filePath,
			);
		}
		for (const item of rawSpawns) {
			if (typeof item !== "string") {
				throw new PeerParsingError(
					`spawns must be an array of strings or "*", got: ${typeof item}`,
					"INVALID_TYPE",
				);
			}
		}
	} else {
		throw new PeerParsingError(
			`spawns must be a string or array, got: ${typeof rawSpawns}`,
			"INVALID_TYPE",
		);
	}

	// Use native normalized spawns
	const spawns = agent.spawns;
	if (!spawns || (Array.isArray(spawns) && spawns.length === 0)) {
		throw new PeerParsingError(
			!spawns ? "Missing required field: spawns" : "spawns cannot be empty",
			!spawns ? "MISSING_SPAWNS" : "EMPTY_SPAWNS",
			filePath,
		);
	}
	if (Array.isArray(spawns)) {
		for (const s of spawns) {
			if (typeof s !== "string" && s !== "*") {
				throw new PeerParsingError(
					`spawns entries must be strings or "*", got: ${typeof s}`,
					"INVALID_SPAWN",
				);
			}
		}
	}

	// Body: nonempty
	if (typeof body !== "string" || body.trim().length === 0) {
		throw new PeerParsingError("body cannot be empty", "EMPTY_BODY", filePath);
	}

	// Tools: explicit non-empty array → add "task" (yield preserved from OMP)
	const tools = agent.tools
		? Array.isArray(agent.tools) && agent.tools.length > 0
			? agent.tools.includes("task")
				? agent.tools
				: [...agent.tools, "task"]
			: agent.tools
		: undefined;

	// Assemble result
	const def: PeerDefinition = {
		...agent,
		spawns,
		body,
		tools,
		workspace: rawFm.workspace as string | undefined,
		rooms: rawFm.rooms as string[] | undefined,
		wake: rawFm.wake as WakeConfig | undefined,
		autonomy: rawFm.autonomy as AutonomyConfig | undefined,
		sandbox: rawFm.sandbox as SandboxConfig | boolean | undefined,
		mcps: rawFm.mcps as string[] | undefined,
		skills: rawFm.skills as string[] | undefined,
		schedules: rawFm.schedules as Schedule[] | undefined,
		automations: rawFm.automations as Automation[] | undefined,
		sha256: "",
	};

	def.sha256 = computeFingerprint(def);
	return def;
}

export function fingerprintPeerDefinition(def: PeerDefinition): string {
	return computeFingerprint(def);
}
