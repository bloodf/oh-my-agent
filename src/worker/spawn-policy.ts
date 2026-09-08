/** Durable peers declare rooms; one-shot work belongs to native task. */
export function classifyAgentSpawn(payload: {
	rooms?: unknown;
	[key: string]: unknown;
}): "peer" | "subtask" {
	return Array.isArray(payload.rooms) && payload.rooms.length > 0
		? "peer"
		: "subtask";
}
