/**
 * Purpose: Centralize environment selectors that can reroute OMP discovery away
 * from a synthetic user root.
 *
 * Public API: `SCRUBBED_ENV_VARS`, `withoutScrubbedEnvVars(env)`, and
 * `blankScrubbedEnvVars()`.
 *
 * Upstream deps: none.
 *
 * Downstream consumers: daemon worker materialization and hermetic test spawns.
 *
 * Failure modes: a newly introduced upstream selector remains inherited until
 * added here. Helpers are pure and do not mutate their input.
 *
 * Performance: O(environment size) copy for removal; O(selector count) blank
 * override construction.
 */

/** Environment variables that reroute OMP/Claude config roots or profiles. */
export const SCRUBBED_ENV_VARS = [
	"PI_CONFIG_DIR",
	"CLAUDE_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"OMP_PROFILE_DIR",
	"PI_PROFILE_DIR",
] as const;

/** Copy a full-replacement process environment without discovery selectors. */
export function withoutScrubbedEnvVars(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const copy = Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	for (const key of SCRUBBED_ENV_VARS) delete copy[key];
	return copy;
}

/** Empty overrides that neutralize selectors when the spawn API merges envs. */
export function blankScrubbedEnvVars(): Record<
	(typeof SCRUBBED_ENV_VARS)[number],
	string
> {
	return Object.fromEntries(
		SCRUBBED_ENV_VARS.map((key) => [key, ""]),
	) as Record<(typeof SCRUBBED_ENV_VARS)[number], string>;
}
