/**
 * Purpose: Expose the worker's six daemon-backed collaboration tools without
 *          giving worker processes direct access to daemon state or room data.
 *
 * Public API: default extension factory `(pi: ExtensionAPI): void`.
 *
 * Upstream deps: OMP ExtensionAPI and agent-dir resolution, the T-507 METHODS
 *                registry, Bun's unix-socket fetch, and classifyAgentSpawn.
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
import { METHODS } from "../shared/protocol-schemas";
import { classifyAgentSpawn } from "./lifecycle";

const TOOL_NAMES = [
	"chat_send",
	"chat_read",
	"chat_wait",
	"agent_spawn",
	"agent_status",
	"task_handoff",
] as const satisfies readonly MethodName[];

interface ToolResult {
	content: [{ type: "text"; text: string }];
	details?: unknown;
	isError?: boolean;
}

const toolError = (message: string): ToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

export default function toolbeltExtension(pi: ExtensionAPI): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const socketPath =
		process.env.OH_MY_AGENT_SOCKET ??
		(basename(dirname(agentDir)) === ".omp" &&
		basename(dirname(dirname(dirname(dirname(agentDir))))) === "workers"
			? resolve(agentDir, "../../../../../daemon.sock")
			: join(agentDir, "oh-my-agent", "daemon.sock"));
	let requestId = 0;

	const call = async (
		method: (typeof TOOL_NAMES)[number],
		params: unknown,
		signal?: AbortSignal,
	): Promise<ToolResult> => {
		const input = METHODS[method].validateParams(params);
		if (!input.ok) {
			return toolError(`${input.field}: ${input.message}`);
		}

		let frame: unknown;
		try {
			const response = await fetch("http://localhost/rpc", {
				unix: socketPath,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: ++requestId,
					method,
					params: input.value,
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
		const output = METHODS[method].validateResult(frame.result);
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

	const z = pi.zod;
	pi.registerTool({
		name: "chat_send",
		label: "Send chat message",
		description: "Post a message to a daemon room.",
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

	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn durable peer",
		description:
			"Create a durable peer with its own lifecycle, rooms, and budget. Never use for coding or one-shot subtasks; dispatch those through native task.",
		loadMode: "essential",
		parameters: z.object({
			name: z.string().describe("Peer definition name"),
			rooms: z
				.array(z.string())
				.optional()
				.describe("Rooms the durable peer joins"),
			cwd: z.string().optional().describe("Peer working directory"),
			expected_output: z
				.string()
				.optional()
				.describe("One-shot output marker; such payloads are refused"),
		}),
		approval: "write",
		execute: async (_id, params, signal) => {
			const spawnParams = params as AgentSpawnParams & {
				expected_output?: string;
			};
			if (classifyAgentSpawn({ ...spawnParams }) === "subtask") {
				return toolError(
					"agent_spawn creates durable peers only; dispatch coding and one-shot subtasks through native task.",
				);
			}
			const daemonParams: AgentSpawnParams = {
				name: spawnParams.name,
				rooms: spawnParams.rooms,
				cwd: spawnParams.cwd,
			};
			return await call("agent_spawn", daemonParams, signal);
		},
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
