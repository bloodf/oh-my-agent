/**
 * Purpose: The T-902 full-screen agent manager. A pure state layer (tree
 * rows, cursor) is split from the OMP-facing component factory, because the
 * suite can drive the first against the real daemon socket and cannot drive
 * a TTY at all.
 *
 * Public API: `ManagerState` (the testable half), `createManagerComponent`
 * (state + callbacks -> a pi-tui `Component`), `managerFactory` (adapts that
 * onto OMP's `ctx.ui.custom` factory signature), `openManager` (the
 * `/manage` command body, including its degradations), and
 * `MANAGER_NEEDS_TUI`.
 *
 * Upstream deps: `./commands` (`DaemonClient`, `ExtensionIO`, `editCommand`),
 * `./widget` (`DAEMON_UNAVAILABLE`), `../shared/protocol` (wire shapes).
 * Nothing here touches daemon state directly: every action is a socket round
 * trip, so the manager holds no duplicated daemon state.
 *
 * Failure modes: an absent daemon is reported before any overlay opens, so
 * the operator never lands in an empty full-screen surface. A host without a
 * TUI (RPC/print) is told the manager needs one.
 */
import type {
	AgentStatus,
	AgentStatusResult,
	InjectResult,
	KillResult,
	LogsTailResult,
} from "../shared/protocol";
import { type DaemonClient, type ExtensionIO, editCommand } from "./commands";
import { PLAIN_THEME, type TuiTheme, themeFrom } from "./theme";

/** Said when the host has no terminal UI to host the overlay. */
export const MANAGER_NEEDS_TUI =
	"The agent manager needs the interactive TUI — use /cli agents in this mode.";

/** One visible line of the tree: an agent, and how deep it sits. */
export interface ManagerRow {
	agent: AgentStatus;
	depth: number;
	/** True when the row's declared parent is not itself running. */
	orphan: boolean;
}

/**
 * The manager's whole model. Deliberately free of any OMP or pi-tui type so
 * the suite drives it against a real socket without a terminal.
 */
export class ManagerState {
	#rows: ManagerRow[] = [];
	#cursor = 0;
	#error: string | undefined;

	constructor(private readonly client: DaemonClient) {}

	get rows(): readonly ManagerRow[] {
		return this.#rows;
	}

	get cursor(): number {
		return this.#cursor;
	}

	/** The last load failure, rendered in place of the tree. */
	get error(): string | undefined {
		return this.#error;
	}

	/** The row the operator is on, or undefined when the tree is empty. */
	selected(): ManagerRow | undefined {
		return this.#rows[this.#cursor];
	}

	/**
	 * Re-read the tree from the daemon. The cursor is kept on the same agent
	 * across a reload where possible, so a kill or a spawn does not silently
	 * move the selection under the operator's hands.
	 */
	async load(): Promise<void> {
		const previous = this.selected()?.agent.name;
		try {
			const result = await this.client.call<AgentStatusResult>(
				"agent_status",
				{},
			);
			this.#rows = flattenTree(result.agents);
			this.#error = undefined;
		} catch (error) {
			this.#rows = [];
			// `DaemonUnavailableError` already carries DAEMON_UNAVAILABLE as its
			// message, so there is nothing to special-case: the daemon's own
			// words reach the operator either way.
			this.#error = error instanceof Error ? error.message : String(error);
		}
		const restored =
			previous === undefined
				? -1
				: this.#rows.findIndex((row) => row.agent.name === previous);
		this.#cursor = restored >= 0 ? restored : 0;
	}

	/** Move the cursor by `delta`, clamped to the tree. */
	moveCursor(delta: number): void {
		if (this.#rows.length === 0) {
			this.#cursor = 0;
			return;
		}
		const next = this.#cursor + delta;
		this.#cursor =
			next < 0 ? 0 : next >= this.#rows.length ? this.#rows.length - 1 : next;
	}

	/** The tree as display lines, cursor marked. */
	renderLines(t: TuiTheme = PLAIN_THEME): string[] {
		if (this.#error !== undefined) return [t.fg("error", this.#error)];
		if (this.#rows.length === 0) {
			return [t.fg("muted", "No agents are running.")];
		}
		return this.#rows.map((row, index) => {
			const selected = index === this.#cursor;
			const marker = selected ? t.fg("accent", t.nav.cursor) : " ";
			const name = selected ? t.bold(row.agent.name) : row.agent.name;
			const state = stateMark(t, row.agent.state);
			const model =
				row.agent.model === undefined ? "" : t.fg("dim", ` ${row.agent.model}`);
			const orphan = row.orphan
				? t.fg("warning", ` (orphan: ${row.agent.parent ?? "missing-parent"})`)
				: "";
			return `${marker} ${"  ".repeat(row.depth)}${name} ${state} ${t.fg("muted", `(${row.agent.account})`)}${model}${orphan}`;
		});
	}

	/**
	 * Kill the selected agent. `keepChildren` is the operator's explicit
	 * cascade choice: the default stops the whole subtree (ADR-011), and the
	 * opt-out reparents the children to root instead.
	 *
	 * `keep_children` is sent snake_case because that is the wire spelling the
	 * daemon validates; it rides past `METHODS` (which checks only declared
	 * fields) and is narrowed server-side, where a non-boolean is refused.
	 */
	async kill(name: string, keepChildren: boolean): Promise<string> {
		return await this.#act(async () => {
			await this.client.call<KillResult>("kill", {
				name,
				keep_children: keepChildren,
			});
			await this.load();
			return keepChildren
				? `Killed ${name}; its children were reparented to root.`
				: `Killed ${name} and everything under it.`;
		});
	}

	/** Tail the agent's buffered output. */
	async logs(name: string, lines = 200): Promise<string[]> {
		try {
			const result = await this.client.call<LogsTailResult>("logs_tail", {
				name,
				lines,
			});
			return result.lines.length === 0 ? ["(no output yet)"] : result.lines;
		} catch (error) {
			return [error instanceof Error ? error.message : String(error)];
		}
	}

	/** Push an instruction into the agent's next turn. */
	async inject(name: string, message: string): Promise<string> {
		return await this.#act(async () => {
			const result = await this.client.call<InjectResult>("inject", {
				name,
				message,
			});
			return result.queued
				? `Queued for ${name}'s next turn.`
				: `Delivered to ${name}.`;
		});
	}

	/** Run a daemon action, returning its message or the failure's. */
	async #act(body: () => Promise<string>): Promise<string> {
		try {
			return await body();
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
}

/**
 * Flatten the daemon's agent list into depth-tagged rows. Parentage arrives
 * two ways (`parent` on the child, `children` on the parent); both are
 * honored, and an agent whose declared parent is absent renders as a root so
 * it can never disappear from the operator's view.
 */
function flattenTree(agents: AgentStatus[]): ManagerRow[] {
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const children = new Map<string, Set<string>>();
	const childrenOf = (name: string): Set<string> => {
		const existing = children.get(name);
		if (existing) return existing;
		const created = new Set<string>();
		children.set(name, created);
		return created;
	};
	for (const agent of agents) {
		if (agent.parent !== undefined && byName.has(agent.parent)) {
			childrenOf(agent.parent).add(agent.name);
		}
		for (const child of agent.children ?? []) {
			if (byName.has(child)) childrenOf(agent.name).add(child);
		}
	}

	const rows: ManagerRow[] = [];
	const seen = new Set<string>();
	const walk = (name: string, depth: number): void => {
		if (seen.has(name)) return;
		seen.add(name);
		const agent = byName.get(name);
		if (agent === undefined) return;
		rows.push({
			agent,
			depth,
			orphan: agent.parent !== undefined && !byName.has(agent.parent),
		});
		for (const child of [...childrenOf(name)].sort()) walk(child, depth + 1);
	};

	const roots = agents
		.filter((agent) => agent.parent === undefined || !byName.has(agent.parent))
		.map((agent) => agent.name)
		.sort();
	for (const root of roots) walk(root, 0);
	// A parentage cycle would leave agents unvisited; show them rather than
	// drop them, because an invisible agent cannot be managed.
	for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name)))
		walk(agent.name, 0);
	return rows;
}

/** Keys the overlay understands. Esc is exact: arrows share its prefix. */
const KEY = {
	escape: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	enter: "\r",
	newline: "\n",
	backspace: "\u007f",
	delete: "\b",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
} as const;

/** Rows of a log tail shown at once. */
const LOG_PANE_ROWS = 20;

/** The per-agent actions the menu offers, in the order it offers them. */
export const ACTIONS = {
	edit: "Edit definition / model",
	logs: "View logs",
	inject: "Inject an instruction",
	kill: "Kill",
} as const;

/** Menu order, and the index the key handler moves through. */
const ACTION_ORDER = [
	ACTIONS.edit,
	ACTIONS.logs,
	ACTIONS.inject,
	ACTIONS.kill,
] as const;

/** The two halves of the cascade choice, spelled as the operator sees them. */
export const CASCADE = {
	subtree: "Kill subtree (children die too)",
	keep: "Keep children (reparent to root)",
} as const;

/** Cascade order; index 1 is the keep-children opt-out. */
const CASCADE_ORDER = [CASCADE.subtree, CASCADE.keep] as const;

/**
 * What the overlay is showing. Every prompt is one of these, drawn inside the
 * fullscreen surface, because a nested OMP dialog would take the alternate
 * screen away from the manager mid-flow.
 */
export type ManagerMode =
	| { kind: "tree" }
	| { kind: "menu"; agent: AgentStatus; index: number }
	| { kind: "confirm-kill"; agent: AgentStatus }
	| { kind: "cascade"; agent: AgentStatus; choice: number }
	| { kind: "inject"; agent: AgentStatus; draft: string }
	| { kind: "logs"; name: string; lines: string[]; offset: number };

/** A completed manager surface action. */
export type ManagerResult = { kind: "edit"; agent: AgentStatus } | undefined;

/** Run the same guided flow `/edit <name>` uses. */
export async function openEditFlow(
	client: DaemonClient,
	io: ExtensionIO,
	agent: AgentStatus,
): Promise<string | undefined> {
	return await editCommand(client, io, agent.name);
}

/**
 * What the component needs from its host. Every prompt except Edit is drawn
 * inside this component. Edit closes the fullscreen surface first, then its
 * result lets `openManager` run OMP's guided dialog over the normal TUI.
 */
export interface ManagerComponentHost {
	/** Close the overlay, optionally requesting a follow-up action. */
	done: (result: ManagerResult) => void;
	/** Ask the host to repaint after asynchronous work. */
	requestRender: () => void;
	/** The host's theme; plain text when a host passes none. */
	theme?: TuiTheme;
}

/** The pi-tui `Component` shape the overlay satisfies. */
export interface ManagerComponent {
	render(width: number): readonly string[];
	handleInput(data: string): void;
}

/**
 * Build the overlay component over an already-constructed state. Split from
 * `managerFactory` so the suite can construct it with a fake host and assert
 * on `render()` output and the Esc path without a terminal.
 */
export function createManagerComponent(
	state: ManagerState,
	host: ManagerComponentHost,
): ManagerComponent {
	let cache: readonly string[] | undefined;
	let cacheWidth = -1;
	let mode: ManagerMode = { kind: "tree" };
	let status = "";
	// A daemon round trip is in flight; input is ignored so one Enter cannot
	// act twice on the same agent.
	let busy = false;

	const repaint = (): void => {
		cache = undefined;
		host.requestRender();
	};

	const toTree = (message: string): void => {
		mode = { kind: "tree" };
		status = message;
		repaint();
	};

	/**
	 * Run a daemon action, holding input until it settles and returning to the
	 * tree with the daemon's own words as the status line.
	 */
	const run = async (body: () => Promise<string>): Promise<void> => {
		busy = true;
		repaint();
		try {
			const message = await body();
			// Every action lands on a fresh tree: agents spawned or finished
			// elsewhere since the last load must be visible in the next frame.
			await state.load();
			mode = { kind: "tree" };
			status = message;
		} finally {
			busy = false;
			repaint();
		}
	};

	/**
	 * Load a log tail and stay in the pane. Kept separate from `run`, which
	 * always lands back on the tree: sharing it would drop the operator out of
	 * the pane the instant it opened.
	 */
	const loadLogs = async (agent: AgentStatus): Promise<void> => {
		busy = true;
		repaint();
		try {
			const lines = await state.logs(agent.name);
			mode = { kind: "logs", name: agent.name, lines, offset: 0 };
			status = "";
		} finally {
			busy = false;
			repaint();
		}
	};

	const chooseAction = (agent: AgentStatus, index: number): void => {
		const action = ACTION_ORDER[index];
		if (action === ACTIONS.edit) {
			host.done({ kind: "edit", agent });
			return;
		}
		if (action === ACTIONS.logs) {
			void loadLogs(agent);
			return;
		}
		if (action === ACTIONS.inject) {
			mode = { kind: "inject", agent, draft: "" };
			repaint();
			return;
		}
		mode = { kind: "confirm-kill", agent };
		repaint();
	};

	return {
		render(width: number): readonly string[] {
			// The engine proves rows are unchanged by reference equality, so an
			// unchanged frame must return the very same array.
			if (cache !== undefined && cacheWidth === width) return cache;
			const lines = renderMode(
				state,
				mode,
				status,
				busy,
				host.theme ?? PLAIN_THEME,
			);
			cacheWidth = width;
			cache = lines;
			return lines;
		},
		handleInput(data: string): void {
			if (busy) {
				// A wedged daemon must not hold the terminal: while a call is in
				// flight, Esc abandons the overlay; the fetch settles on its own.
				if (data === KEY.escape) host.done(undefined);
				return;
			}

			if (mode.kind === "inject") {
				// A text line: Esc abandons, Enter sends, everything printable
				// accumulates. Nothing here reaches the tree's key handling.
				const draft = mode.draft;
				const agent = mode.agent;
				if (data === KEY.escape) {
					toTree("");
					return;
				}
				if (data === KEY.enter || data === KEY.newline) {
					if (draft.trim().length === 0) toTree("");
					else void run(async () => await state.inject(agent.name, draft));
					return;
				}
				if (data === KEY.backspace || data === KEY.delete) {
					mode = { kind: "inject", agent, draft: draft.slice(0, -1) };
					repaint();
					return;
				}
				// Control bytes would render as garbage in the draft line.
				if (data.length === 0 || data < " ") return;
				mode = { kind: "inject", agent, draft: draft + data };
				repaint();
				return;
			}

			if (mode.kind === "confirm-kill") {
				const agent = mode.agent;
				if (data === KEY.escape || data === "n" || data === "N") {
					toTree("");
					return;
				}
				// Only an explicit y proceeds — Enter is a stray keystroke here,
				// and the destructive path is never taken without being named.
				if (data === "y" || data === "Y") {
					mode = { kind: "cascade", agent, choice: 0 };
					repaint();
				}
				return;
			}

			if (mode.kind === "cascade") {
				const agent = mode.agent;
				const choice = mode.choice;
				if (data === KEY.escape) {
					toTree("");
					return;
				}
				if (data === KEY.enter) {
					void run(async () => await state.kill(agent.name, choice === 1));
					return;
				}
				if (data === KEY.up || data === KEY.down) {
					mode = { kind: "cascade", agent, choice: choice === 0 ? 1 : 0 };
					repaint();
				}
				return;
			}

			if (mode.kind === "menu") {
				const agent = mode.agent;
				const index = mode.index;
				if (data === KEY.escape) {
					toTree("");
					return;
				}
				if (data === KEY.enter) {
					chooseAction(agent, index);
					return;
				}
				if (data === KEY.up || data === KEY.down) {
					mode = {
						kind: "menu",
						agent,
						index:
							data === KEY.up
								? (index + ACTION_ORDER.length - 1) % ACTION_ORDER.length
								: (index + 1) % ACTION_ORDER.length,
					};
					repaint();
				}
				return;
			}

			if (mode.kind === "logs") {
				// Esc backs out of the pane rather than closing the overlay: one
				// keystroke never loses more than one level.
				if (data === KEY.escape) {
					toTree("");
					return;
				}
				const delta = scrollDelta(data);
				if (delta === 0) return;
				const max = Math.max(0, mode.lines.length - 1);
				mode = {
					...mode,
					offset: Math.min(max, Math.max(0, mode.offset + delta)),
				};
				repaint();
				return;
			}

			if (data === KEY.escape) {
				host.done(undefined);
				return;
			}
			if (data === KEY.enter || data === KEY.newline) {
				const agent = state.selected()?.agent;
				if (agent === undefined) return;
				mode = { kind: "menu", agent, index: 0 };
				repaint();
				return;
			}
			const delta = scrollDelta(data);
			if (delta === 0) return;
			state.moveCursor(delta);
			status = "";
			repaint();
		},
	};
}

/** Arrow and page keys as a row delta; 0 means "not a movement key". */
function scrollDelta(data: string): number {
	if (data === KEY.up) return -1;
	if (data === KEY.down) return 1;
	if (data === KEY.pageUp) return -10;
	if (data === KEY.pageDown) return 10;
	return 0;
}

/** A peer's state as the operator's status mark plus a colored word. */
function stateMark(t: TuiTheme, state: string): string {
	if (state === "running")
		return t.fg("success", `${t.status.success} running`);
	if (state === "parked") return t.fg("warning", `${t.status.pending} parked`);
	return t.fg("error", `${t.status.error} ${state}`);
}

/** `oh-my-agent — <subject>`, the accent on the name and the rest muted. */
function title(t: TuiTheme, subject: string): string {
	return `${t.bold(t.fg("accent", "oh-my-agent"))} ${t.fg("muted", `— ${subject}`)}`;
}

/** Key hints joined by the operator's separator, dimmed out of the way. */
function hints(t: TuiTheme, ...parts: string[]): string {
	const arrows = t.ascii ? "Up/Down" : "↑/↓";
	return t.fg(
		"dim",
		parts.map((p) => p.replace("↑/↓", arrows)).join(` ${t.sep.dot} `),
	);
}

/** A choice list: the operator's cursor beside the selected row. */
function choices(
	t: TuiTheme,
	labels: readonly string[],
	index: number,
): string[] {
	return labels.map((label, i) =>
		i === index
			? `${t.fg("accent", t.nav.cursor)} ${t.bold(label)}`
			: `  ${label}`,
	);
}

/** Draw whichever mode the manager is in, with the host's theme. */
function renderMode(
	state: ManagerState,
	mode: ManagerMode,
	status: string,
	busy: boolean,
	t: TuiTheme,
): string[] {
	const footer = busy ? t.fg("muted", "working…") : "";
	if (mode.kind === "logs") {
		return [
			title(t, `logs: ${mode.name}`),
			"",
			...mode.lines.slice(mode.offset, mode.offset + LOG_PANE_ROWS),
			"",
			hints(t, "↑/↓ scroll", "Esc back"),
		];
	}
	if (mode.kind === "menu") {
		return [
			title(t, mode.agent.name),
			"",
			...choices(t, ACTION_ORDER, mode.index),
			"",
			footer === "" ? hints(t, "↑/↓ move", "Enter choose", "Esc back") : footer,
		];
	}
	if (mode.kind === "confirm-kill") {
		return [
			title(t, `kill ${mode.agent.name}?`),
			"",
			t.fg(
				"warning",
				`Stop ${mode.agent.name}. You will choose what happens to its children next.`,
			),
			"",
			footer === "" ? hints(t, "y kill", "n cancel", "Esc back") : footer,
		];
	}
	if (mode.kind === "cascade") {
		return [
			title(t, `kill ${mode.agent.name}`),
			"",
			...choices(t, CASCADE_ORDER, mode.choice),
			"",
			footer === ""
				? hints(t, "↑/↓ move", "Enter confirm", "Esc back")
				: footer,
		];
	}
	if (mode.kind === "inject") {
		return [
			title(t, `inject into ${mode.agent.name}`),
			"",
			`${t.fg("accent", ">")} ${mode.draft}`,
			"",
			footer === "" ? hints(t, "Enter send", "Esc cancel") : footer,
		];
	}
	return [
		title(t, "agents"),
		"",
		...state.renderLines(t),
		"",
		...(status === "" ? [] : [t.fg("success", status), ""]),
		footer === "" ? hints(t, "↑/↓ move", "Enter actions", "Esc close") : footer,
	];
}

/** The minimum of OMP's `TUI` the overlay uses; keeps the factory testable. */
export interface ManagerTui {
	requestRender(force?: boolean): void;
}

/**
 * Adapt `createManagerComponent` onto the factory shape `ctx.ui.custom`
 * expects: `(tui, theme, keybindings, done) => component`.
 */
export function managerFactory(state: ManagerState) {
	return (
		tui: ManagerTui,
		theme: unknown,
		_keybindings: unknown,
		done: (result: ManagerResult) => void,
	): ManagerComponent =>
		createManagerComponent(state, {
			done,
			requestRender: () => tui.requestRender(),
			// The host's theme, so the overlay uses the operator's palette and
			// symbol preset; a host that passes none gets plain text.
			theme: themeFrom(theme),
		});
}

/** The host surface `/manage` needs: the mode guard and the custom surface. */
export interface ManagerHostContext {
	mode?: string;
	hasUI?: boolean;
	custom<T>(
		factory: (
			tui: ManagerTui,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => ManagerComponent,
		options?: unknown,
	): Promise<T>;
}

/**
 * `/manage` — open the manager, or say why it cannot open. The daemon is
 * probed before the overlay so an absent one is a sentence rather than an
 * empty full-screen surface the operator has to escape from.
 */
export async function openManager(
	client: DaemonClient,
	io: ExtensionIO,
	ctx: ManagerHostContext,
): Promise<void> {
	if (ctx.hasUI !== true || ctx.mode !== "tui") {
		io.notify(MANAGER_NEEDS_TUI);
		return;
	}

	const state = new ManagerState(client);
	await state.load();
	if (state.error !== undefined) {
		io.notify(state.error);
		return;
	}

	for (;;) {
		const result = await ctx.custom<ManagerResult>(managerFactory(state), {
			overlay: true,
			overlayOptions: { fullscreen: true },
		});
		if (result === undefined) return;

		await openEditFlow(client, io, result.agent);
		await state.load();
	}
}
