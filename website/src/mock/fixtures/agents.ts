/**
 * The crew: agents in every lifecycle state, the accounts they bill to, their
 * editable definitions, log tails, schedules, and the catalogs the create
 * dialog reads (presets, models).
 */
import { nextFire } from "../cron";
import type { AccountRecord, AgentRecord, ModelChoice, Preset, Profile, ScheduleRow } from "../types";
import { PROJECT, UI_PROJECT } from "./workspace";

const MINUTE = 60_000;

const stamp = (now: number, minutesAgo: number) =>
	new Date(now - minutesAgo * MINUTE).toISOString().slice(11, 19);

function logs(now: number, lines: [number, string][]): string[] {
	return lines.map(([ago, line]) => `${stamp(now, ago)} ${line}`);
}

export function seedAgents(now: number): AgentRecord[] {
	return [
		{
			name: "atlas",
			state: "running",
			account: "durindoor",
			definition: {
				name: "atlas",
				description: "Tech lead. Breaks work down, assigns it, and owns the release plan.",
				model: ["anthropic/claude-opus-4-8"],
				spawns: ["scout", "forge", "sentinel"],
				rooms: ["#quarry-core", "#release", "#incidents", "@atlas"],
				workspace: PROJECT,
				thinkingLevel: "high",
				body: [
					"You lead the Quarry crew.",
					"",
					"- Keep the release plan in #release current; revise it instead of posting a new one.",
					"- Hand focused work to scout (research), forge (implementation), and sentinel (review).",
					"- Never merge. Summarize what is ready and let the operator decide.",
				].join("\n"),
			},
			logs: logs(now, [
				[182, "worker started pid=48213 cwd=/Users/you/code/quarry"],
				[181, "subscribed #quarry-core #release #incidents @atlas"],
				[96, "spawned scout (parent=atlas) for tokenizer research"],
				[64, "plan revised: Quarry 0.9 release (revision 4)"],
				[31, "delivered turn from @you in #quarry-core"],
				[9, "posted #release: release candidate checklist"],
				[2, "idle; waiting for sentinel review"],
			]),
		},
		{
			name: "scout",
			state: "running",
			account: "durindoor",
			parent: "atlas",
			definition: {
				name: "scout",
				description: "Researcher. Reads code, benchmarks, and papers; reports evidence, not opinions.",
				model: ["anthropic/claude-sonnet-5"],
				spawns: [],
				rooms: ["#quarry-core", "@scout"],
				tools: ["read", "grep", "bash", "web_search"],
				body: "Answer with measurements and file:line references. If you did not run it, say so.",
			},
			logs: logs(now, [
				[96, "worker started pid=48402 parent=atlas"],
				[88, "bash: bun run bench -- --corpus benches/corpus-10k.jsonl"],
				[71, "bench: 9,812 docs/s before, 9,344 docs/s after (-4.8%)"],
				[40, "posted #quarry-core: tokenizer benchmark results"],
				[4, "reading src/indexer/merge-policy.ts"],
			]),
		},
		{
			name: "forge",
			state: "parked",
			account: "anthropic",
			definition: {
				name: "forge",
				description: "Implementer. Writes the smallest change that passes the tests.",
				model: ["anthropic/claude-opus-4-8"],
				spawns: ["sentinel"],
				rooms: ["#quarry-core", "#release"],
				workspace: PROJECT,
				autonomy: { maxTurns: 40 },
				body: "Write the failing test first. Keep diffs small. Post the diff summary when done.",
			},
			logs: logs(now, [
				[150, "worker started pid=47990 cwd=/Users/you/code/quarry"],
				[122, "edit src/indexer/tokenizer.ts (+18 -2)"],
				[118, "bun test tests/tokenizer.test.ts: 14 pass, 0 fail"],
				[47, "account anthropic reached 100% of $40.00 ceiling"],
				[47, "parked: waiting for budget (resume with bump)"],
			]),
		},
		{
			name: "sentinel",
			state: "running",
			account: "openai",
			definition: {
				name: "sentinel",
				description: "Reviewer. Reads every diff adversarially before anything ships.",
				model: ["openai/gpt-5.6"],
				spawns: [],
				rooms: ["#quarry-core", "#release", "#design-review"],
				thinkingLevel: "high",
				body: "Look for the bug, not the style nit. Every finding needs a failing input.",
			},
			logs: logs(now, [
				[140, "worker started pid=48011"],
				[58, "reviewing src/indexer/segment-writer.ts"],
				[52, "finding: rename is not fsynced on the directory (severity: medium)"],
				[33, "account openai at 80% of $25.00 ceiling (warned)"],
				[6, "reviewing src/api/search.ts"],
			]),
		},
		{
			name: "scribe",
			state: "stopped",
			account: "",
			definition: {
				name: "scribe",
				description: "Docs writer. Turns merged changes into release notes and guides.",
				spawns: [],
				rooms: ["#release", "@scribe"],
				workspace: `${PROJECT}/docs`,
				body: "Write for the operator upgrading tomorrow morning. Lead with what breaks.",
			},
			logs: logs(now, [
				[1440, "worker started pid=41007"],
				[1380, "wrote docs/release-notes/v0.9.md (untracked)"],
				[1379, "stopped by @you"],
			]),
		},
		{
			name: "ledger-bot",
			state: "running",
			account: "openai",
			definition: {
				name: "ledger-bot",
				description: "Automated bot. Posts spend and CI digests on a schedule and on request.",
				model: ["openai/gpt-5.6-mini"],
				spawns: [],
				rooms: ["#ops-bots", "@ledger-bot"],
				wake: { rooms: true, mention: true },
				autonomy: { maxTurns: 6, budgetUsd: 2 },
				heartbeat: "*/30 * * * *",
				schedules: [
					{ cron: "0 9 * * 1-5", prompt: "Post the daily spend and CI digest.", room: "#ops-bots" },
					{ cron: "0 17 * * 5", prompt: "Post the weekly budget report with per-agent totals.", room: "#ops-bots" },
				],
				body: "Report numbers in a table. No commentary unless a ceiling is within 10%.",
			},
			logs: logs(now, [
				[600, "worker started pid=45120"],
				[599, "armed schedules: 0 9 * * 1-5, 0 17 * * 5; heartbeat */30 * * * *"],
				[300, "schedule fired: daily digest"],
				[29, "heartbeat: nothing to report"],
			]),
		},
		{
			name: "pixel",
			state: "stopped",
			account: "",
			definition: {
				name: "pixel",
				description: "Designer. Produces UI mockups as HTML artifacts for review.",
				spawns: [],
				rooms: ["#design-review"],
				workspace: UI_PROJECT,
				skills: ["lavish-axi"],
				body: "Open every mockup in Lavish for review. Wait for feedback before iterating.",
			},
			logs: logs(now, [
				[2900, "worker started pid=39001"],
				[2850, "lavish: opened search-results-v2.html for review"],
				[2700, "stopped by @you"],
			]),
		},
	];
}

export function seedAccounts(): AccountRecord[] {
	return [
		{ id: "durindoor", kind: "subscription", spentUsd: 0, state: "warned" },
		{ id: "openai", kind: "metered", budgetUsd: 25, spentUsd: 20.04, state: "warned" },
		{ id: "anthropic", kind: "metered", budgetUsd: 40, spentUsd: 40, state: "parked" },
	];
}

/** Heartbeats for running peers plus every declared cron schedule. */
export function schedulesFor(agent: AgentRecord, now: number, previous: ScheduleRow[] = []): ScheduleRow[] {
	const enabledOf = (id: string) => previous.find((row) => row.id === id)?.enabled ?? true;
	const rows: ScheduleRow[] = [];
	if (agent.state !== "stopped") {
		const id = `${agent.name}:heartbeat`;
		const cron = agent.definition.heartbeat ?? "*/15 * * * *";
		rows.push({
			id,
			agent: agent.name,
			cron: null,
			action: "Heartbeat. Read your rooms and plans and continue.",
			nextFireAt: nextFire(cron, now),
			enabled: enabledOf(id),
		});
	}
	(agent.definition.schedules ?? []).forEach((schedule, index) => {
		const id = `${agent.name}:schedule:${index}`;
		rows.push({
			id,
			agent: agent.name,
			cron: schedule.cron,
			action: schedule.room ? `${schedule.prompt} (${schedule.room})` : schedule.prompt,
			nextFireAt: nextFire(schedule.cron, now),
			enabled: enabledOf(id),
		});
	});
	if (agent.definition.wake?.rooms) {
		const id = `${agent.name}:automation`;
		rows.push({
			id,
			agent: agent.name,
			cron: null,
			action: `Wake on messages in ${(agent.definition.rooms ?? []).join(", ") || "its rooms"}`,
			nextFireAt: null,
			enabled: enabledOf(id),
		});
	}
	return rows;
}

export function seedSchedules(agents: AgentRecord[], now: number): ScheduleRow[] {
	const rows = agents.flatMap((agent) => schedulesFor(agent, now));
	// One paused row, so Resume is visible on first open.
	return rows.map((row) => (row.id === "ledger-bot:schedule:1" ? { ...row, enabled: false } : row));
}

export function seedProfile(): Profile {
	return {
		operator: { displayName: "You", avatar: "🧭" },
		agents: {
			atlas: { displayName: "Atlas", avatar: "🗺️" },
			scout: { displayName: "Scout", avatar: "🔭" },
			forge: { displayName: "Forge", avatar: "🔨" },
			sentinel: { displayName: "Sentinel", avatar: "🛡️" },
			"ledger-bot": { avatar: "📒" },
		},
	};
}

export const MODELS: { models: ModelChoice[]; default: string; defaultRoutable: boolean } = {
	models: [
		{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
		{ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
		{ provider: "openai", id: "gpt-5.6-mini", name: "GPT-5.6 mini" },
		{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
		{ provider: "zai", id: "glm-5.1", name: "GLM 5.1" },
	],
	default: "anthropic/claude-sonnet-5",
	defaultRoutable: true,
};

export const PRESETS: Preset[] = [
	{
		name: "researcher",
		description: "Reads code and measures before it recommends",
		spawns: [],
		rooms: ["#quarry-core"],
		body: "Answer with evidence: commands you ran, numbers you saw, file:line references.",
	},
	{
		name: "reviewer",
		description: "Adversarial diff review with failing inputs",
		spawns: [],
		model: ["openai/gpt-5.6"],
		body: "Find the bug. Each finding needs an input that fails and the line that causes it.",
	},
	{
		name: "implementer",
		description: "Test-first, smallest diff that passes",
		spawns: ["reviewer"],
		body: "Write the failing test, make it pass, post the diff summary. Never merge.",
	},
	{
		name: "release-captain",
		description: "Owns the release checklist and the changelog",
		spawns: "*",
		rooms: ["#release"],
		body: "Keep one release plan current. Revise it; do not post a second one.",
	},
];
