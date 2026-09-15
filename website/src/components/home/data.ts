import { themes } from "@/lib/themes";

// Every fact on the homepage comes from the repository. The source file is noted
// beside each value so a future edit can re-check it.

export const GITHUB_URL = "https://github.com/bloodf/oh-my-agent";
export const NPM_URL = "https://www.npmjs.com/package/@bloodf/oh-my-agent";
const BLOB = `${GITHUB_URL}/blob/main`;
export const DOCS = {
	gettingStarted: `${BLOB}/docs/guide/getting-started.md`,
	cli: `${BLOB}/docs/guide/cli.md`,
	concepts: `${BLOB}/docs/guide/concepts.md`,
	console: `${BLOB}/docs/web-console.md`,
	remote: `${BLOB}/docs/remote-exposure.md`,
	architecture: `${BLOB}/ARCHITECTURE.md`,
	security: `${BLOB}/SECURITY.md`,
	changelog: `${BLOB}/CHANGELOG.md`,
	docs: `${GITHUB_URL}/tree/main/docs`,
};

// package.json "version" / CHANGELOG.md top entry.
export const VERSION = "1.6.1";
export const INSTALL = "omp install @bloodf/oh-my-agent";

// docs/guide/cli.md, the "### <verb>" headings under "## Verbs": 18 verbs.
export const CLI_VERBS = [
	"setup",
	"status",
	"audit",
	"agents",
	"agent create",
	"presets",
	"models",
	"agent show",
	"agent edit",
	"spawn",
	"kill",
	"rooms",
	"schedule",
	"logs",
	"inject",
	"bump",
	"console",
	"daemon",
] as const;

// README.md "Quick start": mate plus four staff peers seeded on first boot.
export const DEFAULT_CREW = ["mate", "staff-pm", "staff-backend", "staff-frontend", "staff-qa"] as const;

// README.md "Quick start": ten presets that are never seeded.
export const PRESETS = [
	"researcher",
	"reviewer",
	"security-reviewer",
	"tech-writer",
	"sre",
	"debugger",
	"test-engineer",
	"designer",
	"release-manager",
	"data-analyst",
] as const;

// web/src/lib/themes.ts: the curated workspace themes, counted at build time.
export const CONSOLE_THEMES = themes.length;

// docs/remote-exposure.md: tickets have a 30-second TTL; the audit caps live connections at 32.
export const TICKET_TTL_SECONDS = 30;
export const AUDIT_CONNECTION_CAP = 32;

export type QuickStartTab = { id: string; label: string; note: string; lines: string[] };

// README.md "Quick start" and docs/guide/cli.md.
export const QUICK_START: QuickStartTab[] = [
	{
		id: "omp",
		label: "OMP install",
		note: "Needs Bun ≥ 1.3.14 and OMP ≥ 18.1.0",
		lines: ["omp install @bloodf/oh-my-agent", "omp", "/setup", "/rooms post #bridge @mate add dark mode and fix the flaky login test"],
	},
	{
		id: "cli",
		label: "Shell CLI",
		note: "Optional. Full path, no export",
		lines: [
			"~/.omp/plugins/node_modules/.bin/omp-agent status",
			"~/.omp/plugins/node_modules/.bin/omp-agent agent create researcher researcher.md",
			"~/.omp/plugins/node_modules/.bin/omp-agent spawn researcher",
		],
	},
	{
		id: "console",
		label: "Browser console",
		note: "Inside omp: a menu, or the raw loopback URL",
		lines: ["/console", "/cli console"],
	},
];

// docs/guide/concepts.md "Peers vs native task agents", README.md "Features".
export const COMPARE_ROWS: { label: string; task: string; peer: string }[] = [
	{ label: "Lifetime", task: "This run only", peer: "Survives restarts" },
	{ label: "Closing the TUI", task: "The agent dies", peer: "The daemon keeps it running" },
	{ label: "Transcript", task: "Folds back into the parent run", peer: "Own lifecycle, rooms, budget" },
	{ label: "Talks to other agents", task: "—", peer: "Persistent channels and DMs" },
	{ label: "Schedules", task: "—", peer: "Cron, one-shot timers, heartbeat" },
	{ label: "Budget ceiling", task: "—", peer: "Warn at 80%, park at 100%" },
	{ label: "How you start it", task: "Native task tool", peer: "omp-agent spawn or agent_spawn" },
];
