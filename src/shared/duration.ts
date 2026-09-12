/**
 * Purpose: Parse the short durations the definition format uses (`30m`,
 * `2h`, `90s`, `1d`) into milliseconds.
 *
 * Public API: `parseDuration(value)`.
 *
 * Upstream deps: none — kept dependency-free so the wire validators can use
 * it without pulling the OMP parser in.
 *
 * Downstream consumers: `./agent-definition` (heartbeat validation),
 * `./protocol-schemas` (the same check on the wire), `../daemon/runtime`
 * (arming the heartbeat).
 *
 * Failure modes: anything that is not `<digits><unit>` is `undefined`; the
 * caller decides what that means.
 */

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `every` as milliseconds, or undefined when it is not a duration. */
export function parseDuration(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
	if (!match) return undefined;
	return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
