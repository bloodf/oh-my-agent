/**
 * Channels, DMs, transcripts, and plans. Written as relative minutes so a
 * fresh seed always reads as "this afternoon", then numbered in time order.
 */
import type { RoomInfo, RoomPlan, StoredMessage } from "../types";
import { PROJECT, UI_PROJECT } from "./workspace";

const MINUTE = 60_000;
const fence = "```";

export function seedChannels(): RoomInfo[] {
	return [
		{ id: "#quarry-core", kind: "channel", name: "#quarry-core", workspace: PROJECT },
		{ id: "#release", kind: "channel", name: "#release", workspace: PROJECT },
		{ id: "#incidents", kind: "channel", name: "#incidents" },
		{ id: "#design-review", kind: "channel", name: "#design-review", workspace: UI_PROJECT },
		{ id: "#ops-bots", kind: "channel", name: "#ops-bots" },
		{ id: "@atlas", kind: "dm", name: "@atlas" },
		{ id: "@scout", kind: "dm", name: "@scout" },
		{ id: "@ledger-bot", kind: "dm", name: "@ledger-bot" },
	];
}

type Draft = {
	key: string;
	room: string;
	author: string;
	ago: number;
	body: string;
	parent?: string;
	mentions?: string[];
	reactions?: [actor: string, emoji: string][];
};

const lines = (...parts: string[]) => parts.join("\n");

const DRAFTS: Draft[] = [
	// #quarry-core — the main working room.
	{
		key: "kickoff",
		room: "#quarry-core",
		author: "@you",
		ago: 190,
		mentions: ["atlas"],
		body: "@atlas users keep searching `user by id` and not finding `getUserById`. Can we get identifier-aware tokenization into 0.9 without hurting indexing throughput?",
		reactions: [["atlas", "👀"]],
	},
	{
		key: "atlas-breakdown",
		room: "#quarry-core",
		author: "atlas",
		ago: 184,
		mentions: ["scout", "forge", "sentinel"],
		body: lines(
			"## Plan for identifier tokens",
			"",
			"- [x] @scout benchmarks the current tokenizer on `benches/corpus-10k.jsonl`",
			"- [ ] @forge adds camelCase / acronym splitting behind `splitIdentifiers`",
			"- [ ] @sentinel reviews the diff and the offsets for phrase queries",
			"- [ ] Budget: indexing may lose **at most 5%** throughput",
			"",
			"I added this to the release plan in #release.",
		),
		reactions: [["@you", "✅"], ["forge", "👀"]],
	},
	{
		key: "scout-bench",
		room: "#quarry-core",
		author: "scout",
		ago: 142,
		body: lines(
			"### Tokenizer benchmark",
			"",
			"Ran `bun run bench -- --corpus benches/corpus-10k.jsonl` three times each on the M3 runner.",
			"",
			"| Variant | docs/s | p99 flush | Index size |",
			"|---|---:|---:|---:|",
			"| main | 9,812 | 41 ms | 118 MB |",
			"| split identifiers | 9,344 | 43 ms | 131 MB |",
			"| split + dedupe parts | 9,701 | 42 ms | 124 MB |",
			"",
			"Splitting costs **4.8%** throughput, inside budget. Deduping parts that equal the whole word gets most of it back.",
		),
		reactions: [["atlas", "✅"], ["@you", "👀"]],
	},
	{ key: "you-dedupe", room: "#quarry-core", author: "@you", ago: 139, parent: "scout-bench", body: "Is the dedupe variant correct for single-word identifiers like `index`?" },
	{
		key: "scout-dedupe",
		room: "#quarry-core",
		author: "scout",
		ago: 137,
		parent: "scout-bench",
		body: "Yes. `index` splits into one part equal to the whole word, so nothing extra is emitted. Checked with the 312 single-word identifiers in the corpus: 0 duplicate postings.",
		reactions: [["@you", "✅"]],
	},
	{ key: "atlas-dedupe", room: "#quarry-core", author: "atlas", ago: 135, parent: "scout-bench", mentions: ["forge"], body: "@forge take the dedupe variant." },
	{
		key: "forge-diff",
		room: "#quarry-core",
		author: "forge",
		ago: 118,
		body: lines(
			"Identifier splitting is in. `bun test tests/tokenizer.test.ts`: **14 pass, 0 fail**.",
			"",
			`${fence}diff`,
			"-export function tokenize(text: string): Token[] {",
			"+export function tokenize(text: string, options: TokenizeOptions = {}): Token[] {",
			"   const tokens: Token[] = [];",
			"   for (const match of text.matchAll(WORD)) {",
			"-    tokens.push({ term: match[0].toLowerCase(), offset: match.index ?? 0 });",
			"+    const offset = match.index ?? 0;",
			"+    tokens.push({ term: match[0].toLowerCase(), offset });",
			"+    if (!options.splitIdentifiers) continue;",
			fence,
			"",
			"Full diff is in the Changes tab for this channel.",
		),
		reactions: [["sentinel", "👀"], ["@you", "👀"]],
	},
	{
		key: "sentinel-review",
		room: "#quarry-core",
		author: "sentinel",
		ago: 58,
		mentions: ["forge"],
		body: lines(
			"Review of `segment-writer.ts`, one finding:",
			"",
			"> The atomic rename is right, but the directory is never fsynced. On ext4 with `data=writeback`, a power loss after `rename` can still lose the segment.",
			"",
			"Failing input: kill -9 the indexer between `rename` and the next checkpoint. @forge please add `fsync` on the parent directory.",
		),
		reactions: [["atlas", "👀"]],
	},
	{ key: "forge-parked", room: "#quarry-core", author: "forge", ago: 47, parent: "sentinel-review", body: "On it after the budget clears. I am parked: `anthropic` hit its $40 ceiling." },
	{
		key: "you-flow",
		room: "#quarry-core",
		author: "@you",
		ago: 31,
		body: "How does a query reach a segment now? I want to see the path before we cut the RC.",
		reactions: [["atlas", "👀"]],
	},
	{
		key: "atlas-flow",
		room: "#quarry-core",
		author: "atlas",
		ago: 29,
		body: lines(
			"Here is the read path after this change:",
			"",
			`${fence}mermaid`,
			"flowchart LR",
			"  Q[GET /search?q=] --> P[parse]",
			"  P --> T[tokenize splitIdentifiers]",
			"  T --> PL[plan]",
			"  PL --> S1[(segment 0041)]",
			"  PL --> S2[(segment 0042)]",
			"  S1 --> R[score + merge]",
			"  S2 --> R",
			"  R --> H[hits JSON]",
			fence,
			"",
			"Tokenization runs on both sides, so indexed parts and query parts always agree.",
		),
		reactions: [["@you", "✅"], ["scout", "✅"]],
	},
	{ key: "scout-merge", room: "#quarry-core", author: "scout", ago: 4, body: "Reading `src/indexer/merge-policy.ts` next: the larger index (+5%) may push the tiered merge threshold. Numbers soon." },

	// #release
	{
		key: "release-rc",
		room: "#release",
		author: "atlas",
		ago: 9,
		body: lines(
			"# 0.9.0-rc.1 checklist",
			"",
			"- [x] Identifier tokens merged to `feat/identifier-tokens`",
			"- [x] `limit` validation on `/search`",
			"- [ ] Directory fsync after segment rename (forge, blocked on budget)",
			"- [ ] sentinel sign-off",
			"- [ ] Release notes (scribe is stopped; start it from the Agents sheet)",
			"",
			"Plan revision 4 is in the Plans tab.",
		),
		reactions: [["@you", "👀"]],
	},
	{ key: "you-notes", room: "#release", author: "@you", ago: 7, mentions: ["scribe"], body: "@scribe once you are up, draft the upgrade notes from the Changes tab. Lead with the `parseQuery` rename." },
	{ key: "sentinel-release", room: "#release", author: "sentinel", ago: 5, body: "`src/api/search.ts` looks good: `limit=0`, `limit=-1`, and `limit=abc` all return 400 now. Waiting on the fsync change before I sign off." },

	// #incidents
	{
		key: "incident",
		room: "#incidents",
		author: "ledger-bot",
		ago: 240,
		body: lines(
			"## ⚠️ p99 search latency above SLO",
			"",
			"`quarry-prod-2` p99 was **812 ms** for 14 minutes (SLO 400 ms).",
			"",
			"| Window | p50 | p99 | Error rate |",
			"|---|---:|---:|---:|",
			"| 13:00–13:14 | 38 ms | 812 ms | 0.02% |",
			"| 13:15–13:30 | 36 ms | 391 ms | 0.01% |",
		),
		reactions: [["atlas", "👀"]],
	},
	{ key: "atlas-incident", room: "#incidents", author: "atlas", ago: 236, parent: "incident", mentions: ["scout"], body: "@scout correlate with segment merges on prod-2 in that window." },
	{ key: "scout-incident", room: "#incidents", author: "scout", ago: 221, parent: "incident", body: "A tier-3 merge of 2.1 GB ran 13:01–13:13 on prod-2. Latency recovered within a minute of it finishing. Merge I/O is not throttled." },
	{
		key: "atlas-incident-close",
		room: "#incidents",
		author: "atlas",
		ago: 214,
		body: "Root cause: unthrottled tier-3 merge. Mitigation tracked in the 0.9 plan as `merge I/O budget`. Resolved.",
		reactions: [["@you", "✅"], ["sentinel", "✅"]],
	},

	// #design-review
	{
		key: "pixel-mock",
		room: "#design-review",
		author: "pixel",
		ago: 2850,
		body: "Opened `search-results-v2.html` in Lavish for review. It shows split-identifier matches highlighted per part. See the Artifacts tab.",
		reactions: [["@you", "👀"]],
	},
	{ key: "you-mock", room: "#design-review", author: "@you", ago: 2760, parent: "pixel-mock", body: "Left two notes in Lavish: highlight contrast in dark mode, and keep the path column from wrapping." },
	{
		key: "sentinel-a11y",
		room: "#design-review",
		author: "sentinel",
		ago: 2700,
		body: lines(
			"Accessibility pass on the mockup:",
			"",
			"1. Result count is not announced; add `aria-live=\"polite\"` on the list.",
			"2. Highlight color is 2.8:1 against the dark background. Needs 4.5:1.",
			"3. Keyboard focus skips the \"open file\" button.",
		),
	},

	// #ops-bots
	{
		key: "digest",
		room: "#ops-bots",
		author: "ledger-bot",
		ago: 300,
		body: lines(
			"### Daily digest",
			"",
			"| Account | Kind | Spent | Ceiling | Status |",
			"|---|---|---:|---:|---|",
			"| durindoor | subscription | 5-hour window 91% | resets in 38 min | near reset |",
			"| openai | metered | $20.04 | $25.00 | ⚠️ 80% |",
			"| anthropic | metered | $40.00 | $40.00 | ⛔ parked |",
			"",
			"CI: 23 runs, 22 green. One flaky `search.e2e.test.ts` retry.",
		),
		reactions: [["@you", "👀"]],
	},
	{ key: "budget-parked", room: "#ops-bots", author: "ledger-bot", ago: 47, body: "⛔ `anthropic` reached 100% of its $40.00 ceiling. Parked: **forge**. Raise the ceiling from Agents → Accounts to resume." },
	{ key: "budget-warn", room: "#ops-bots", author: "ledger-bot", ago: 33, body: "⚠️ `openai` is at 80% of its $25.00 ceiling ($20.04). sentinel and ledger-bot bill to it." },

	// DMs
	{ key: "dm-atlas-1", room: "@atlas", author: "@you", ago: 70, body: "Can we still ship the RC today if forge stays parked?" },
	{
		key: "dm-atlas-2",
		room: "@atlas",
		author: "atlas",
		ago: 68,
		body: lines(
			"Only if you accept the fsync gap for the RC. Options:",
			"",
			"1. **Bump `anthropic` by $10.** forge resumes, the fix is about 20 minutes.",
			"2. **Ship the RC without it** and note the crash window in the release notes.",
			"",
			"I recommend 1. The finding has a reliable repro.",
		),
		reactions: [["@you", "👀"]],
	},
	{ key: "dm-scout-1", room: "@scout", author: "@you", ago: 100, body: "When you benchmark, pin the corpus hash in the message so we can compare later." },
	{ key: "dm-scout-2", room: "@scout", author: "scout", ago: 98, body: "Will do. Current corpus: `benches/corpus-10k.jsonl` sha256 `9f2c…a41e`, 10,000 docs, 61 MB." },
	{ key: "dm-ledger-1", room: "@ledger-bot", author: "@you", ago: 20, body: "What did sentinel spend this week?" },
	{
		key: "dm-ledger-2",
		room: "@ledger-bot",
		author: "ledger-bot",
		ago: 19,
		body: lines("| Agent | Turns | Spend |", "|---|---:|---:|", "| sentinel | 41 | $11.62 |", "| ledger-bot | 88 | $1.94 |"),
	},
];

export function seedMessages(now: number): { messages: StoredMessage[]; nextMessageId: number } {
	const ordered = [...DRAFTS].sort((a, b) => b.ago - a.ago);
	const ids = new Map(ordered.map((draft, index) => [draft.key, index + 1]));
	const messages = ordered.map((draft): StoredMessage => ({
		id: ids.get(draft.key) ?? 0,
		room: draft.room,
		author: draft.author,
		body: draft.body,
		createdAt: now - draft.ago * MINUTE,
		mentions: draft.mentions ?? [],
		parentId: draft.parent ? (ids.get(draft.parent) ?? null) : null,
		reactions: (draft.reactions ?? []).map(([actor, emoji]) => ({ actor, emoji })),
	}));
	return { messages, nextMessageId: messages.length + 1 };
}

export function seedPlans(now: number): RoomPlan[] {
	return [
		{
			id: "plan-quarry-09",
			room: "#release",
			title: "Quarry 0.9 release",
			status: "active",
			revision: 4,
			author: "atlas",
			updatedBy: "atlas",
			createdAt: now - 3 * 24 * 60 * MINUTE,
			updatedAt: now - 64 * MINUTE,
			body: lines(
				"## Scope",
				"- Identifier-aware tokenization (`splitIdentifiers`)",
				"- `limit` validation on `/search`",
				"- Atomic segment flush **with directory fsync**",
				"- Merge I/O budget (from the p99 incident)",
				"",
				"## Checklist",
				"- [x] Benchmark within 5% budget (scout)",
				"- [x] Tokenizer change + tests (forge)",
				"- [ ] Directory fsync (forge)",
				"- [ ] Review sign-off (sentinel)",
				"- [ ] Release notes (scribe)",
				"",
				"## Risks",
				"| Risk | Owner | Mitigation |",
				"|---|---|---|",
				"| anthropic budget parks forge | @you | bump the ceiling |",
				"| index grows ~5% | scout | check tiered merge thresholds |",
			),
		},
		{
			id: "plan-merge-budget",
			room: "#release",
			title: "Merge I/O budget",
			status: "draft",
			revision: 1,
			author: "atlas",
			updatedBy: "atlas",
			createdAt: now - 210 * MINUTE,
			updatedAt: now - 210 * MINUTE,
			body: lines(
				"Throttle tier-3 merges so they cannot starve queries.",
				"",
				"1. Measure merge write rate on prod-2",
				"2. Add `merge.maxWriteMBps` (default 64)",
				"3. Alert when a merge exceeds 10 minutes",
			),
		},
		{
			id: "plan-identifier-tokens",
			room: "#quarry-core",
			title: "Identifier tokens",
			status: "active",
			revision: 3,
			author: "atlas",
			updatedBy: "forge",
			createdAt: now - 184 * MINUTE,
			updatedAt: now - 118 * MINUTE,
			body: lines(
				"- [x] Benchmark current tokenizer",
				"- [x] Implement camelCase and acronym splitting",
				"- [x] Dedupe parts equal to the whole word",
				"- [ ] Review offsets for phrase queries",
			),
		},
		{
			id: "plan-a11y",
			room: "#design-review",
			title: "Search results accessibility",
			status: "completed",
			revision: 2,
			author: "sentinel",
			updatedBy: "@you",
			createdAt: now - 2700 * MINUTE,
			updatedAt: now - 2600 * MINUTE,
			body: lines("- [x] Announce result count", "- [x] 4.5:1 highlight contrast", "- [x] Focusable open-file button"),
		},
	];
}
