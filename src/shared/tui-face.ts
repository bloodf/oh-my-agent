/**
 * Purpose: A TUI-sized face for a wire author. Terminals cannot paint SVG, so
 * this is the blobatar's body fill as a colored disc — same seed as the
 * console, one cell wide.
 *
 * Public API: `blobatarSvg`, `blobatarBodyFill`, `tuiFaceMark`.
 *
 * Upstream deps: `blobatar/blob` (renderer only). No network.
 *
 * Downstream consumers: the `/manage` tree in `src/extension/manager.ts`.
 */
import { blobatar } from "blobatar/blob";

const DISC = "●";

/** SVG markup for a name; same bytes as `blobatar(name)` in the console. */
export function blobatarSvg(name: string): string {
	return blobatar(name);
}

/** First fill in the SVG is the body; the second is the eyes. */
export function blobatarBodyFill(name: string): string {
	const match = /fill="(#[0-9a-fA-F]{6})"/.exec(blobatarSvg(name));
	return match?.[1] ?? "#888888";
}

/**
 * One cell: a disc, optionally truecolor from the blobatar body.
 * `colored` is false on the plain theme so tests and ASCII hosts stay
 * unstyled.
 */
export function tuiFaceMark(name: string, colored: boolean): string {
	if (!colored) return DISC;
	const fill = blobatarBodyFill(name);
	const r = Number.parseInt(fill.slice(1, 3), 16);
	const g = Number.parseInt(fill.slice(3, 5), 16);
	const b = Number.parseInt(fill.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${DISC}\x1b[0m`;
}
