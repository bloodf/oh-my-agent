/**
 * Independent OMP chats (native sessions with their own model and todo
 * state) and the Lavish artifacts agents opened for review.
 */
import type { ArtifactRow, ChatRecord, WebChatModel } from "../types";
import { PROJECT, UI_PROJECT } from "./workspace";

const MINUTE = 60_000;

export const CHAT_MODELS: WebChatModel[] = [
	{ provider: "anthropic", id: "claude-opus-4-8", contextWindow: 1_000_000, reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" } },
	{ provider: "anthropic", id: "claude-sonnet-5", contextWindow: 1_000_000, reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" } },
	{ provider: "openai", id: "gpt-5.6", contextWindow: 400_000, reasoning: true },
	{ provider: "google", id: "gemini-3-pro", contextWindow: 2_000_000, reasoning: true },
	{ provider: "zai", id: "glm-5.1", contextWindow: 200_000, reasoning: false },
];

export function seedChats(now: number): ChatRecord[] {
	const benchCreated = now - 55 * MINUTE;
	const notesCreated = now - 26 * 60 * MINUTE;
	return [
		{
			info: { id: "chat-7f3a", title: "Merge policy thresholds", cwd: PROJECT, createdAt: benchCreated, updatedAt: now - 12 * MINUTE, provider: "anthropic", modelId: "claude-opus-4-8" },
			state: {
				id: "chat-7f3a",
				title: "Merge policy thresholds",
				cwd: PROJECT,
				createdAt: benchCreated,
				updatedAt: now - 12 * MINUTE,
				provider: "anthropic",
				modelId: "claude-opus-4-8",
				running: true,
				streaming: false,
				compacting: false,
				sessionId: "01JZ7F3A9QK2M4",
				model: { provider: "anthropic", id: "claude-opus-4-8" },
				thinkingLevel: "medium",
				messageCount: 4,
				queuedMessageCount: 0,
				todoPhases: [
					{
						name: "Investigate",
						tasks: [
							{ content: "Read src/indexer/merge-policy.ts", status: "completed" },
							{ content: "Measure segment size distribution after identifier splitting", status: "completed" },
						],
					},
					{
						name: "Propose",
						tasks: [
							{ content: "Recommend tier thresholds for a 5% larger index", status: "in_progress" },
							{ content: "Validate on prod-2 snapshot", status: "blocked", blocker: "Needs read access to the prod-2 snapshot bucket" },
							{ content: "Write ADR for merge I/O budget", status: "pending" },
						],
					},
				],
			},
			messages: [
				{ role: "user", timestamp: benchCreated, content: "Will a ~5% bigger index change when tiered merges trigger? Look at merge-policy.ts and tell me whether thresholds need to move." },
				{
					role: "assistant",
					timestamp: benchCreated + 40_000,
					content: [
						{ type: "thinking", thinking: "Start with the tier boundaries, then compare against segment sizes from the benchmark run." },
						{ type: "toolCall", id: "call_1", name: "read", intent: "Read src/indexer/merge-policy.ts" },
					],
				},
				{
					role: "assistant",
					timestamp: benchCreated + 95_000,
					content: [
						{
							type: "text",
							text: [
								"Tier boundaries are fixed byte sizes: **64 MB, 512 MB, 4 GB** (`merge-policy.ts:18`).",
								"",
								"With identifier splitting, a typical flushed segment grows from 58 MB to 61 MB, so it still lands in tier 1. The tier-2 → tier-3 boundary is where it matters: 8 × 512 MB merges now happen about 5% sooner.",
								"",
								"That is the merge that caused the p99 incident, so I would pair this with the I/O budget rather than moving thresholds.",
							].join("\n"),
						},
					],
				},
				{ role: "user", timestamp: now - 12 * MINUTE, content: "Agreed. Draft the threshold recommendation as a table." },
			],
			models: CHAT_MODELS,
		},
		{
			info: { id: "chat-2c91", title: "Result list polish", cwd: UI_PROJECT, createdAt: notesCreated, updatedAt: notesCreated + 20 * MINUTE, provider: "openai", modelId: "gpt-5.6" },
			state: {
				id: "chat-2c91",
				title: "Result list polish",
				cwd: UI_PROJECT,
				createdAt: notesCreated,
				updatedAt: notesCreated + 20 * MINUTE,
				provider: "openai",
				modelId: "gpt-5.6",
				running: true,
				streaming: false,
				compacting: false,
				sessionId: "01JZ2C91XH7B0P",
				model: { provider: "openai", id: "gpt-5.6" },
				messageCount: 2,
				queuedMessageCount: 0,
				todoPhases: [
					{
						name: "Accessibility fixes",
						tasks: [
							{ content: "Add aria-live to ResultList", status: "completed" },
							{ content: "Raise highlight contrast to 4.5:1", status: "completed" },
							{ content: "Make open-file button focusable", status: "abandoned" },
						],
					},
				],
			},
			messages: [
				{ role: "user", timestamp: notesCreated, content: "Apply sentinel's three accessibility findings to src/ResultList.tsx." },
				{
					role: "assistant",
					timestamp: notesCreated + 20 * MINUTE,
					content: [
						{ type: "toolCall", id: "call_9", name: "edit", intent: "Edit src/ResultList.tsx" },
						{ type: "text", text: "\nDone: the list announces result counts and highlights use `oklch(0.78 0.14 85)` (4.9:1 on dark). The open-file button was already removed in the new row design, so I dropped that task." },
					],
				},
			],
			models: CHAT_MODELS,
		},
	];
}

export function seedArtifacts(now: number): ArtifactRow[] {
	const iso = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString();
	return [
		{ file: `${PROJECT}/docs/review/release-0.9-dashboard.html`, url: "/console/review/release-dashboard", status: "feedback", pendingPrompts: 2, updatedAt: iso(14) },
		{ file: `${UI_PROJECT}/mockups/search-results-v2.html`, url: "/console/review/search-results", status: "open", pendingPrompts: 0, updatedAt: iso(2760) },
		{ file: `${PROJECT}/docs/review/merge-io-budget.html`, url: "/console/review/merge-budget", status: "closed", pendingPrompts: 0, updatedAt: iso(4300) },
	];
}
