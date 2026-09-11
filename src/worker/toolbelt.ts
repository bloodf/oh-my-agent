/**
 * Purpose: Expose the worker's twelve daemon-backed collaboration tools without
 *          giving worker processes direct access to daemon state or room data.
 *
 * Public API: default extension factory `(pi: ExtensionAPI): void`.
 *
 * Upstream deps: OMP ExtensionAPI and agent-dir resolution, the T-507 METHODS
 *                registry, local reaction validation pending protocol support,
 *                Bun's unix-socket fetch, and classifyAgentSpawn.
 *
 * Downstream consumers: materialized OMP worker sessions.
 *
 * Failure modes: Invalid inputs, invalid daemon results, protocol failures, and
 *                unavailable sockets return concise tool errors. Calls are safe
 *                to retry only when the corresponding daemon method is safe.
 *
 * Performance: One unix-socket round trip per tool call; chat_wait intentionally
 *              holds that request open until a message or timeout.
 */

import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";

import type { AgentSpawnParams, MethodName } from "../shared/protocol";
import { METHODS, type Validation } from "../shared/protocol-schemas";
import { classifyAgentSpawn } from "./spawn-policy";

const TOOL_NAMES = [
	"chat_send",
	"chat_read",
	"chat_wait",
	"agent_create",
	"presets_list",
	"agent_spawn",
	"room_create",
	"room_join",
	"agent_status",
	"task_handoff",
	"room_plans_list",
	"room_plan_create",
	"room_plan_update",
] as const satisfies readonly MethodName[];

interface ToolResult {
	content: [{ type: "text"; text: string }];
	details?: unknown;
	isError?: boolean;
}

const REACTION_EMOJIS = ["👀", "⏳", "✅", "❌"] as const;
type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
type ReactionMethod = "chat_react" | "chat_unreact";

const SELECTION_GUIDANCE =
	"native task for temporary in-run subagents; agent_create then agent_spawn with parent for persistent children (presets_list offers ready-made roles to copy); agent_spawn without parent for top-level peers; post to a room to talk to an existing peer";

interface ReactionParams {
	messageId: number;
	emoji: ReactionEmoji;
}

interface SpawnToolParams {
	name: string;
	rooms?: string[];
	cwd?: string;
	parent?: boolean;
	expected_output?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReactionParams(value: unknown): Validation<ReactionParams> {
	if (!isRecord(value)) {
		return { ok: false, field: "params", message: "expected an object" };
	}
	if (
		typeof value.messageId !== "number" ||
		!Number.isSafeInteger(value.messageId) ||
		value.messageId <= 0
	) {
		return {
			ok: false,
			field: "messageId",
			message: "messageId must be a positive safe integer",
		};
	}
	if (!REACTION_EMOJIS.includes(value.emoji as ReactionEmoji)) {
		return {
			ok: false,
			field: "emoji",
			message: `emoji must be one of ${REACTION_EMOJIS.join(", ")}`,
		};
	}
	return {
		ok: true,
		value: { messageId: value.messageId, emoji: value.emoji as ReactionEmoji },
	};
}

/**
 * The shared result contract, plus this tool's own emoji allowlist.
 *
 * The daemon's reaction methods accept any non-empty emoji string; the tool
 * offers four, and a reply naming anything else is a daemon this worker does
 * not understand.
 */
function validateReactionResult(
	method: ReactionMethod,
	value: unknown,
): Validation<{ messageId: number; emoji: ReactionEmoji }> {
	const shared = METHODS[method].validateResult(value);
	if (!shared.ok) return shared;
	const emoji = (shared.value as { emoji: string }).emoji;
	if (!REACTION_EMOJIS.includes(emoji as ReactionEmoji)) {
		return {
			ok: false,
			field: "emoji",
			message: `emoji must be one of ${REACTION_EMOJIS.join(", ")}`,
		};
	}
	return shared as Validation<{ messageId: number; emoji: ReactionEmoji }>;
}

const toolError = (message: string): ToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

export interface ToolbeltConnection {
	socketPath: string;
	controlToken: string;
	actor: string;
}

export default function toolbeltExtension(
	pi: ExtensionAPI,
	connection?: ToolbeltConnection,
): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const materializedWorker =
		basename(dirname(agentDir)) === ".omp" &&
		basename(dirname(dirname(dirname(dirname(agentDir))))) === "workers";
	const actor =
		connection?.actor ??
		(materializedWorker ? basename(resolve(agentDir, "../../..")) : undefined);
	const socketPath =
		connection?.socketPath ??
		process.env.OH_MY_AGENT_SOCKET ??
		(materializedWorker
			? resolve(agentDir, "../../../../../daemon.sock")
			: join(agentDir, "oh-my-agent", "daemon.sock"));
	const controlToken =
		connection?.controlToken ?? process.env.OH_MY_AGENT_CONTROL_TOKEN;
	let requestId = 0;

	const callValidated = async <TParams, TResult>(
		method: string,
		params: unknown,
		validateParams: (value: unknown) => Validation<TParams>,
		validateResult: (value: unknown) => Validation<TResult>,
		signal?: AbortSignal,
		mapParams?: (value: TParams) => unknown,
	): Promise<ToolResult> => {
		const input = validateParams(params);
		if (!input.ok) {
			return toolError(`${input.field}: ${input.message}`);
		}

		let frame: unknown;
		try {
			const response = await fetch("http://localhost/rpc", {
				unix: socketPath,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(controlToken === undefined
						? {}
						: { Authorization: `Bearer ${controlToken}` }),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: ++requestId,
					method,
					params: mapParams ? mapParams(input.value) : input.value,
				}),
				signal,
			});
			frame = await response.json();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toolError(`oh-my-agent daemon unavailable: ${message}`);
		}

		if (typeof frame !== "object" || frame === null) {
			return toolError("oh-my-agent daemon returned an invalid response");
		}
		if ("error" in frame) {
			const error = frame.error;
			return toolError(
				typeof error === "object" &&
					error !== null &&
					"message" in error &&
					typeof error.message === "string"
					? error.message
					: "oh-my-agent daemon returned an invalid protocol error",
			);
		}
		if (!("result" in frame)) {
			return toolError("oh-my-agent daemon returned an invalid response");
		}
		const output = validateResult(frame.result);
		if (!output.ok) {
			return toolError(
				`${method} result violates protocol at ${output.field}: ${output.message}`,
			);
		}
		return {
			content: [{ type: "text", text: JSON.stringify(output.value) }],
			details: output.value,
		};
	};

	const call = async (
		method: (typeof TOOL_NAMES)[number],
		params: unknown,
		signal?: AbortSignal,
	): Promise<ToolResult> =>
		await callValidated(
			method,
			params,
			METHODS[method].validateParams,
			METHODS[method].validateResult,
			signal,
		);

	const callReaction = async (
		method: ReactionMethod,
		params: unknown,
		signal?: AbortSignal,
	): Promise<ToolResult> => {
		const input = validateReactionParams(params);
		if (!input.ok) {
			return toolError(`${input.field}: ${input.message}`);
		}
		if (actor === undefined) {
			return toolError(
				"reaction actor unavailable outside a materialized worker",
			);
		}
		// The registry's contract first, then this tool's own narrower rule.
		// A private copy of the whole shape required a `reacted` field the
		// protocol never declared and ignored the `added`/`removed` ones it
		// does, so a conforming daemon would have been refused and the worker
		// never learned whether its reaction was new. The emoji allowlist is
		// genuinely local — the protocol accepts any non-empty string — so it
		// is layered on rather than folded in.
		return await callValidated(
			method,
			input.value,
			() => input,
			(value) => validateReactionResult(method, value),
			signal,
			(value) => ({ ...value, actor }),
		);
	};

	const z = pi.zod;
	pi.registerTool({
		name: "chat_send",
		label: "Send chat message",
		description: `Post a message to a daemon room. Use this to talk to an existing peer; ${SELECTION_GUIDANCE}.`,
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Room id"),
			body: z.string().describe("Message body"),
			author: z.string().optional().describe("Author override"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("chat_send", params, signal),
	});

	pi.registerTool({
		name: "chat_read",
		label: "Read chat messages",
		description: "Read room messages after an optional cursor.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Room id"),
			sinceId: z.number().optional().describe("Last message id already seen"),
			limit: z.number().optional().describe("Maximum messages to return"),
		}),
		approval: "read",
		execute: async (_id, params, signal) =>
			await call("chat_read", params, signal),
	});

	pi.registerTool({
		name: "chat_wait",
		label: "Wait for chat",
		description:
			"Block on the daemon until new matching messages arrive after the cursor or the timeout expires.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().optional().describe("Optional room id"),
			sinceId: z.number().optional().describe("Last message id already seen"),
			timeoutMs: z.number().optional().describe("Maximum wait in milliseconds"),
		}),
		approval: "read",
		execute: async (_id, params, signal) =>
			await call("chat_wait", params, signal),
	});

	const reactionDescription =
		"Use reactions to communicate status without chat noise: 👀 reading/picked-up, ⏳ in-progress, ✅ done, ❌ blocked/failed.";
	const reactionParameters = z.object({
		messageId: z.number().describe("Message id"),
		emoji: z.string().describe("One of 👀, ⏳, ✅, ❌"),
	});

	pi.registerTool({
		name: "chat_react",
		label: "Add chat reaction",
		description: reactionDescription,
		loadMode: "essential",
		parameters: reactionParameters,
		approval: "write",
		execute: async (_id, params, signal) =>
			await callReaction("chat_react", params, signal),
	});

	pi.registerTool({
		name: "chat_unreact",
		label: "Remove chat reaction",
		description: reactionDescription,
		loadMode: "essential",
		parameters: reactionParameters,
		approval: "write",
		execute: async (_id, params, signal) =>
			await callReaction("chat_unreact", params, signal),
	});

	pi.registerTool({
		name: "room_plans_list",
		label: "List room plans",
		description: "List durable plans for one room.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Room id"),
		}),
		approval: "read",
		execute: async (_id, params, signal) =>
			await call("room_plans_list", params, signal),
	});

	pi.registerTool({
		name: "room_plan_create",
		label: "Create room plan",
		description: "Create a durable draft plan in one of this worker's rooms.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Room id"),
			title: z.string().describe("Plan title"),
			body: z.string().describe("Plan body"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("room_plan_create", params, signal),
	});

	pi.registerTool({
		name: "room_plan_update",
		label: "Update room plan",
		description:
			"Update a durable plan using the revision returned by the latest list, create, or update call. On conflict, list again before retrying.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Room id"),
			id: z.string().describe("Plan id"),
			title: z.string().optional().describe("Replacement title"),
			body: z.string().optional().describe("Replacement body"),
			status: z
				.enum(["draft", "active", "completed"])
				.optional()
				.describe("Replacement status"),
			expectedRevision: z
				.number()
				.describe("Current positive integer revision for optimistic update"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("room_plan_update", params, signal),
	});

	pi.registerTool({
		name: "presets_list",
		label: "List peer presets",
		description:
			"The shipped role presets (researcher, reviewer, security-reviewer, tech-writer, sre, debugger, test-engineer, designer, release-manager, data-analyst). Each is a complete agent_create payload: copy its fields under a new name and pass them to agent_create, then agent_spawn.",
		loadMode: "essential",
		parameters: z.object({}),
		approval: "read",
		execute: async (_id, _params, signal) =>
			await call("presets_list", {}, signal),
	});

	pi.registerTool({
		name: "agent_create",
		label: "Create peer definition",
		description: `Write a parse-validated peer definition without starting it. ${SELECTION_GUIDANCE}.`,
		loadMode: "essential",
		parameters: z.object({
			name: z.string().describe("Peer definition name"),
			description: z.string().describe("Peer purpose"),
			model: z.array(z.string()).optional().describe("Ordered model choices"),
			rooms: z.array(z.string()).optional().describe("Default rooms"),
			wake: z
				.object({
					mention: z.boolean().optional(),
					rooms: z.boolean().optional(),
				})
				.optional()
				.describe("Wake policy"),
			autonomy: z
				.object({
					maxTurns: z.number().optional(),
					budgetUsd: z.number().optional(),
				})
				.optional()
				.describe("Run limits"),
			spawns: z
				.union([z.array(z.string()), z.literal("*")])
				.optional()
				.describe("Native task-agent allowlist"),
			body: z.string().describe("Peer instructions"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("agent_create", params, signal),
	});

	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn durable peer",
		description: `Start a durable peer with its own lifecycle, rooms, and budget. Never use for coding or one-shot subtasks; dispatch those through native task. ${SELECTION_GUIDANCE}. Parentage is cooperative metadata, never an authority boundary.`,
		loadMode: "essential",
		parameters: z.object({
			name: z.string().describe("Peer definition name"),
			rooms: z
				.array(z.string())
				.optional()
				.describe("Rooms the durable peer joins"),
			cwd: z.string().optional().describe("Peer working directory"),
			parent: z
				.boolean()
				.optional()
				.describe("Set true to deploy this peer as your persistent child"),
			expected_output: z
				.string()
				.optional()
				.describe("One-shot output marker; such payloads are refused"),
		}),
		approval: "write",
		execute: async (_id, params, signal) => {
			const spawnParams = params as SpawnToolParams;
			if (
				spawnParams.expected_output !== undefined ||
				(spawnParams.parent !== true &&
					classifyAgentSpawn({ ...spawnParams }) === "subtask")
			) {
				return toolError(
					"agent_spawn creates durable peers only; dispatch coding and one-shot subtasks through native task.",
				);
			}
			const daemonParams: AgentSpawnParams = {
				name: spawnParams.name,
				rooms: spawnParams.rooms,
				cwd: spawnParams.cwd,
			};
			if (spawnParams.parent === true) {
				if (actor === undefined) {
					return toolError(
						"worker identity unavailable; cannot record child parentage",
					);
				}
				daemonParams.parent = actor;
			}
			return await call("agent_spawn", daemonParams, signal);
		},
	});

	pi.registerTool({
		name: "room_create",
		label: "Create channel",
		description:
			"Open a channel (id starting with #) for a piece of work. Then room_join the peers who should be in it, or @mention them there: a mention invites a peer into the room and hands it the whole history.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Channel id, e.g. #login-page"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("room_create", params, signal),
	});

	pi.registerTool({
		name: "room_join",
		label: "Add peer to room",
		description:
			"Assign a peer to a channel or DM. Persisted in its definition; a running peer is subscribed at once and receives the room's backlog as its next turn.",
		loadMode: "essential",
		parameters: z.object({
			room: z.string().describe("Room id starting with # or @"),
			agent: z.string().describe("Peer name"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("room_join", params, signal),
	});

	pi.registerTool({
		name: "agent_status",
		label: "Read agent status",
		description: "Read one peer's status or list all peer statuses.",
		loadMode: "essential",
		parameters: z.object({
			name: z.string().optional().describe("Optional peer name"),
		}),
		approval: "read",
		execute: async (_id, params, signal) =>
			await call("agent_status", params, signal),
	});

	pi.registerTool({
		name: "task_handoff",
		label: "Hand off task",
		description:
			"Post a durable task handoff to another peer through the daemon.",
		loadMode: "essential",
		parameters: z.object({
			fromAgent: z.string().describe("Sending peer"),
			toAgent: z.string().describe("Receiving peer"),
			summary: z.string().describe("Work being handed off"),
			artifacts: z
				.array(z.string())
				.optional()
				.describe("Artifact paths or URLs"),
		}),
		approval: "write",
		execute: async (_id, params, signal) =>
			await call("task_handoff", params, signal),
	});
}
