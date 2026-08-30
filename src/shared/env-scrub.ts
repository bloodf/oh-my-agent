/**
 * Purpose: Centralize the two sides of a worker's environment policy — the
 * selectors that must never be inherited, and the allowlist that is the only
 * thing a child may see.
 *
 * Public API: `SCRUBBED_ENV_VARS`, `PASSTHROUGH_ENV_VARS`,
 * `withoutScrubbedEnvVars(env)`, `blankScrubbedEnvVars()`, and
 * `passthroughEnvVars(host)`.
 *
 * Upstream deps: none.
 *
 * Downstream consumers: daemon worker materialization and hermetic test spawns.
 *
 * The allowlist side (T-1005): a worker child is spawned through a controlled
 * re-exec that hands it exactly the materialized layout map — never a merge
 * over the host env. That map = synthetic roots (HOME and the XDG roots,
 * PI_CODING_AGENT_DIR, and the OH_MY_AGENT_ prefix, declared by the
 * materializer) PLUS the passthrough list below. Anything undeclared — provider keys, tokens,
 * POISON — is simply absent from the child.
 *
 * Passthroughs, each named and justified:
 * - `PATH`   — the child must resolve `bun` (and any toolchain binary) when it
 *   spawns subprocesses; without PATH a worker cannot run its own runtime.
 * - `TERM`   — terminal capability detection for the RPC child's output layer;
 *   absent TERM degrades rendering but never affects secrets.
 *
 * Deliberately NOT passed through:
 * - `LANG`/`LC_*` — OMP/Bun default to UTF-8; inheriting a host locale also
 *   inherits host-specific collation/encoding behavior a worker must not
 *   depend on.
 * - `TMPDIR` — a host temp path may point outside the worker's writable roots
 *   (and under a seatbelt profile would be denied); the default /tmp is
 *   covered by the sandbox policy.
 * - `SHELL`  — the child never spawns an interactive login shell; tool calls
 *   that need a shell resolve one themselves.
 * - `NODE_PATH`/`BUN_*` — module/toolchain overrides from the host would let
 *   the host environment reroute what the worker loads.
 * - every config-root/profile selector in SCRUBBED_ENV_VARS — those are
 *   undeclared, so under the allowlist they are absent, not blanked.
 *
 * Failure modes: a newly introduced upstream selector remains inherited until
 * added here. Helpers are pure and do not mutate their input.
 *
 * Performance: O(environment size) copy for removal; O(selector count) blank
 * override construction; O(passthrough count) allowlist extraction.
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

/**
 * Host variables a worker child legitimately needs, copied verbatim when the
 * host sets them. The complete justification per variable lives in the header
 * comment above; this list is the only host-to-child channel.
 */
export const PASSTHROUGH_ENV_VARS = ["PATH", "TERM"] as const;

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

/**
 * The host values of the declared passthroughs, for the materialized layout
 * env. A passthrough the host does not set is omitted entirely — an
 * allowlisted key must never be present-but-empty.
 */
export function passthroughEnvVars(
	host: Readonly<Record<string, string | undefined>>,
): Partial<Record<(typeof PASSTHROUGH_ENV_VARS)[number], string>> {
	const picked: Record<string, string> = {};
	for (const key of PASSTHROUGH_ENV_VARS) {
		const value = host[key];
		if (value !== undefined) picked[key] = value;
	}
	return picked;
}
