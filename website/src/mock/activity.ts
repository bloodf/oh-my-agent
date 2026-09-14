/**
 * The simulated crew: agents that answer the operator, a slow trickle of
 * progress while a console is open, and streamed replies in OMP chats. All of
 * it goes through the same writes and frames as operator actions.
 */
import { listenerCount, publish } from "./bus";
import { postMessage, setReaction } from "./messages";
import { getState, update } from "./store";
import type { AgentRecord, RoomMessage, WebChatContentBlock, WebChatMessage } from "./types";

const HUMAN = "@you";
const LIVE_INTERVAL_MS = 40_000;
const FIRST_TICK_MS = 12_000;

const pick = <T>(items: readonly T[], seed: number): T => items[Math.abs(seed) % items.length] as T;

const REPLIES: Record<string, readonly string[]> = {
	atlas: [
		"On it. I split this into two tasks and added them to the plan:\n\n- [ ] scout gathers numbers first\n- [ ] forge implements once we agree on scope",
		"Noted. That changes the release order: I moved it ahead of the merge budget work in plan revision {rev}.",
		"Good call. I will hold the RC until sentinel signs off on this.",
	],
	scout: [
		"Checking now. I will post numbers with the corpus hash, not a guess.",
		"Quick read of the code first:\n\n```ts\n// src/indexer/merge-policy.ts:18\nconst TIERS = [64 * MB, 512 * MB, 4 * GB];\n```\n\nBenchmark results in a few minutes.",
		"I found two call sites that matter: `src/api/search.ts:29` and `src/query/plan.ts:44`. Reading both.",
	],
	forge: [
		"Writing the failing test first, then the fix. Diff summary when it is green.",
		"Done locally: `bun test` 118 pass, 0 fail. Pushing the diff for sentinel.",
	],
	sentinel: [
		"Reviewing. I will post findings with a failing input for each, or a sign-off.",
		"No blocking findings on this one. One nit: the error message should name the parameter.",
		"| Check | Result |\n|---|---|\n| Tests | ✅ 118 pass |\n| Offsets | ✅ phrase queries align |\n| Crash safety | ⏳ waiting on fsync |",
	],
	scribe: ["Drafting now. Upgrade notes lead with the `parseQuery` → `parse` rename."],
	"ledger-bot": [
		"| Account | Spent today |\n|---|---:|\n| openai | $3.12 |\n| anthropic | $0.00 (parked) |\n| durindoor | subscription |",
		"Noted. I will include that in the next digest.",
	],
	pixel: ["Opening a revised mockup in Lavish. It will show up in the Artifacts tab."],
};

const PROGRESS: Record<string, readonly string[]> = {
	atlas: [
		"Status: tokenizer work is done, fsync fix is waiting on the anthropic budget, review is in progress.",
		"Re-read the plan against what landed today. Nothing new is blocked.",
		"Reminder: the RC needs sentinel's sign-off and release notes before it is cut.",
	],
	scout: [
		"Merge thresholds: flushed segments grew 58 MB → 61 MB. Still tier 1, so no threshold change needed there.",
		"Ran `bun test` on the branch: **118 pass, 0 fail**, 4.1 s.",
		"Tier-2 → tier-3 merges will trigger about 5% sooner. Pairing that with the merge I/O budget is enough.",
	],
	sentinel: [
		"Reviewed `src/query/parse.ts`: the rename is clean and every caller is updated.",
		"Fuzzed `/search?limit=` with 2,000 inputs. All non-integers return 400; no 500s.",
	],
	"ledger-bot": [
		"Heartbeat: CI green on `feat/identifier-tokens` (3 runs). Spend moved +$0.41.",
		"Heartbeat: `openai` at 82% of its ceiling. No action needed yet.",
	],
	forge: ["Resumed. Adding `fsync` on the segment directory after rename."],
	scribe: ["Release notes draft updated with the merge I/O budget section."],
	pixel: ["Mockup revision 3 uploaded for review."],
};

function agent(name: string): AgentRecord | undefined {
	return getState().agents.find((a) => a.name === name);
}

function runningMembers(room: string): AgentRecord[] {
	return getState().agents.filter((a) => a.state === "running" && (a.definition.rooms ?? []).includes(room));
}

function appendLog(name: string, line: string): void {
	const stamp = new Date().toISOString().slice(11, 19);
	update((s) => ({
		...s,
		agents: s.agents.map((a) => (a.name === name ? { ...a, logs: [...a.logs, `${stamp} ${line}`].slice(-200) } : a)),
	}));
}

const timers = new Set<ReturnType<typeof setTimeout>>();

function later(ms: number, run: () => void): void {
	const timer = setTimeout(() => {
		timers.delete(timer);
		try {
			run();
		} catch {
			// A room or message removed by Reset: the simulated turn is dropped.
		}
	}, ms);
	timers.add(timer);
}

/** Cancel pending simulated turns, e.g. before a data reset. */
export function cancelActivity(): void {
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
	if (liveTimer !== undefined) clearInterval(liveTimer);
	liveTimer = undefined;
	for (const stop of streams.values()) stop();
	streams.clear();
}

/** Who answers an operator message: mentions first, then the DM peer, then one member. */
function responders(message: RoomMessage): AgentRecord[] {
	const mentioned = (message.mentions ?? []).map(agent).filter((a): a is AgentRecord => a?.state === "running");
	if (mentioned.length > 0) return mentioned.slice(0, 2);
	if (message.room.startsWith("@")) {
		const peer = agent(message.room.slice(1));
		return peer?.state === "running" ? [peer] : [];
	}
	const members = runningMembers(message.room);
	return members.length ? [pick(members, message.id)] : [];
}

export function answerOperator(message: RoomMessage): void {
	if (message.author !== HUMAN) return;
	responders(message).forEach((peer, index) => {
		const delay = 2_200 + index * 1_600 + (message.id % 5) * 250;
		later(700 + index * 400, () => setReaction(message.id, peer.name, "👀", true));
		later(delay, () => {
			appendLog(peer.name, `delivered turn from @you in ${message.room}`);
			const revision = getState().plans.find((p) => p.room === message.room)?.revision ?? 1;
			const body = pick(REPLIES[peer.name] ?? REPLIES.atlas ?? [], message.id + index).replace("{rev}", String(revision + 1));
			postMessage(message.room, peer.name, body, message.threadRootId ?? message.parentId);
			appendLog(peer.name, `posted ${message.room}`);
		});
	});
}

// ── Live trickle while a console is connected ────────────────────────────────

let liveTimer: ReturnType<typeof setInterval> | undefined;
let tickCount = 0;

function openRoom(): string | undefined {
	const channels = getState().channels;
	const fromUrl = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("room");
	return channels.find((room) => room.id === fromUrl)?.id ?? channels[0]?.id;
}

export function tick(): void {
	if (listenerCount() === 0) {
		if (liveTimer !== undefined) clearInterval(liveTimer);
		liveTimer = undefined;
		return;
	}
	tickCount += 1;
	const room = openRoom();
	if (room) {
		const speakers = room.startsWith("@") ? [agent(room.slice(1))].filter((a): a is AgentRecord => a?.state === "running") : runningMembers(room);
		const speaker = speakers.length ? pick(speakers, tickCount) : undefined;
		if (speaker) {
			postMessage(room, speaker.name, pick(PROGRESS[speaker.name] ?? PROGRESS.atlas ?? [], tickCount), null);
			appendLog(speaker.name, `posted progress in ${room}`);
		}
	}
	if (tickCount % 3 === 0) {
		// Somewhere the operator is not looking, so the rail shows an unread dot.
		const bot = agent("ledger-bot");
		const elsewhere = (bot?.definition.rooms ?? []).find((id) => id !== room && getState().channels.some((c) => c.id === id));
		if (elsewhere && bot?.state === "running") {
			postMessage(elsewhere, bot.name, pick(PROGRESS["ledger-bot"] ?? [], tickCount), null);
		}
	}
	if (tickCount % 4 === 0) {
		const scout = agent("scout");
		if (scout && scout.state !== "stopped") {
			const state = scout.state === "running" ? "parked" : "running";
			update((s) => ({ ...s, agents: s.agents.map((a) => (a.name === "scout" ? { ...a, state } : a)) }));
			appendLog("scout", state === "parked" ? "idle; parked until next wake" : "woke on heartbeat");
			publish({ type: "agent", agent: "scout", state });
		}
	}
	if (tickCount % 5 === 0 && agent("ledger-bot")?.state === "running") {
		appendLog("ledger-bot", "schedule fired: heartbeat");
		publish({ type: "schedule", agent: "ledger-bot", phase: "fired" });
	}
}

/** Start the trickle on the first open console; it stops itself when none remain. */
export function ensureLive(): void {
	if (liveTimer !== undefined) return;
	liveTimer = setInterval(tick, LIVE_INTERVAL_MS);
	later(FIRST_TICK_MS, tick);
}

// ── Streamed replies in independent OMP chats ────────────────────────────────

const streams = new Map<string, () => void>();

const CHAT_ANSWERS: readonly string[] = [
	"| Tier | Current | Recommended | Why |\n|---|---:|---:|---|\n| 1 | 64 MB | 64 MB | flushed segments are 61 MB |\n| 2 | 512 MB | 512 MB | unchanged |\n| 3 | 4 GB | 4 GB + I/O budget | throttle instead of moving the boundary |\n\nKeep the thresholds and add `merge.maxWriteMBps = 64`. That addresses the p99 incident without changing merge frequency.",
	"I checked the files you referenced. The change is small:\n\n```diff\n-const limit = Number(params.get(\"limit\") ?? 20);\n+const limit = Math.min(requested, MAX_LIMIT);\n```\n\nTests pass locally: `bun test tests/search.e2e.test.ts` → 9 pass.",
	"Here is what I would do next:\n\n1. Add a failing test for the edge case.\n2. Make the smallest change that passes it.\n3. Re-run the tokenizer benchmark to confirm we stay within the 5% budget.",
];

function updateChat(chatId: string, change: (messages: WebChatMessage[]) => WebChatMessage[], streaming: boolean): void {
	update((s) => ({
		...s,
		chats: s.chats.map((chat) => {
			if (chat.info.id !== chatId) return chat;
			const messages = change(chat.messages);
			const now = Date.now();
			return {
				...chat,
				info: { ...chat.info, updatedAt: now },
				messages,
				state: { ...chat.state, updatedAt: now, streaming, messageCount: messages.length },
			};
		}),
	}));
}

export function streamChatReply(chatId: string): void {
	streams.get(chatId)?.();
	const answer = pick(CHAT_ANSWERS, getState().chats.find((c) => c.info.id === chatId)?.messages.length ?? 0);
	const words = answer.split(/(?<=\s)/);
	const started = Date.now();
	const assistant = (text: string, stopReason?: string): WebChatMessage => ({
		role: "assistant",
		timestamp: started,
		content: [
			{ type: "toolCall", id: `call_${started}`, name: "read", intent: "Read the referenced files" } satisfies WebChatContentBlock,
			// Leading blank line: the console joins blocks with one newline, which Markdown folds.
			...(text ? [{ type: "text", text: `\n${text}` } satisfies WebChatContentBlock] : []),
		],
		...(stopReason ? { stopReason } : {}),
	});
	const replaceLast = (text: string, stopReason?: string) => (messages: WebChatMessage[]) => [...messages.slice(0, -1), assistant(text, stopReason)];
	let shown = 0;
	updateChat(chatId, (messages) => [...messages, assistant("")], true);
	publish({ type: "chat", chatId, event: { type: "agent_start" } });
	const interval = setInterval(() => {
		shown = Math.min(words.length, shown + 6);
		const done = shown >= words.length;
		updateChat(chatId, replaceLast(words.slice(0, shown).join(""), done ? "stop" : undefined), !done);
		publish({ type: "chat", chatId, event: { type: done ? "agent_end" : "message_update" } });
		if (done) stop();
	}, 450);
	const stop = () => {
		clearInterval(interval);
		streams.delete(chatId);
	};
	streams.set(chatId, stop);
}

export function abortChat(chatId: string): boolean {
	const stop = streams.get(chatId);
	if (!stop) return false;
	stop();
	updateChat(
		chatId,
		(messages) => {
			const last = messages.at(-1);
			return last?.role === "assistant" ? [...messages.slice(0, -1), { ...last, stopReason: "aborted" }] : messages;
		},
		false,
	);
	publish({ type: "chat", chatId, event: { type: "agent_end", aborted: true } });
	return true;
}
