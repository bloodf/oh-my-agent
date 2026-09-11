/**
 * Purpose: The slice of OMP's `Theme` the TUI surfaces render with, and a
 * plain fallback for hosts that hand over nothing.
 *
 * Public API: `TuiTheme`, `PLAIN_THEME`, `themeFrom(candidate)`.
 *
 * Upstream deps: none. OMP's `Theme` satisfies `TuiTheme` structurally, so
 * nothing here imports it; the extension keeps loading on a host whose theme
 * module has moved.
 *
 * Downstream consumers: `./manager` (the overlay), `./widget` (the status
 * line), `./index` (adapts `ui.setWidget`'s component factory).
 *
 * Failure modes: a candidate missing any method degrades to `PLAIN_THEME`,
 * which styles nothing and uses unicode marks — the same text the surfaces
 * rendered before they were themed, so a test or an older host sees no
 * regression, only no color.
 */

/** What the surfaces ask of a theme: colors, weight, and the operator's symbols. */
export interface TuiTheme {
	fg(color: TuiColor, text: string): string;
	bold(text: string): string;
	/** Status marks, in the operator's symbol preset. */
	status: { success: string; error: string; warning: string; pending: string };
	/** Navigation marks: the cursor is what the manager draws beside a row. */
	nav: { cursor: string; back: string };
	/** Separators; `dot` joins the widget's segments. */
	sep: { dot: string };
	/** Whether the preset is ASCII, so arrow hints can say "Up/Down". */
	ascii: boolean;
}

/** The theme colors these surfaces use. A subset of OMP's `ThemeColor`. */
export type TuiColor =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text";

/** No color, unicode marks: what the surfaces drew before they were themed. */
export const PLAIN_THEME: TuiTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	status: { success: "✓", error: "✗", warning: "!", pending: "…" },
	nav: { cursor: "›", back: "‹" },
	sep: { dot: "·" },
	ascii: false,
};

function hasFunction(value: unknown, key: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)[key] === "function"
	);
}

/**
 * Adapt whatever the host passed as its theme. OMP's `Theme` has `fg`,
 * `bold`, the `status`/`nav`/`sep` symbol accessors, and `getSymbolPreset`;
 * anything short of that gets the plain fallback rather than a crash inside
 * a render.
 */
export function themeFrom(candidate: unknown): TuiTheme {
	if (!hasFunction(candidate, "fg") || !hasFunction(candidate, "bold")) {
		return PLAIN_THEME;
	}
	const theme = candidate as {
		fg(color: string, text: string): string;
		bold(text: string): string;
		status?: Partial<TuiTheme["status"]>;
		nav?: Partial<TuiTheme["nav"]>;
		sep?: Partial<TuiTheme["sep"]>;
		getSymbolPreset?(): string;
	};
	return {
		fg: (color, text) => theme.fg(color, text),
		bold: (text) => theme.bold(text),
		status: { ...PLAIN_THEME.status, ...pick(theme.status) },
		nav: { ...PLAIN_THEME.nav, ...pick(theme.nav) },
		sep: { ...PLAIN_THEME.sep, ...pick(theme.sep) },
		ascii: theme.getSymbolPreset?.() === "ascii",
	};
}

/** Only string-valued entries; a getter that threw or returned junk is skipped. */
function pick<T extends object>(value: T | undefined): Partial<T> {
	if (typeof value !== "object" || value === null) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" && entry.length > 0) out[key] = entry;
	}
	return out as Partial<T>;
}
