/**
 * Purpose: Build a child-process environment that host shell config cannot reroute.
 *   OMP discovery resolves user config roots from PI_CONFIG_DIR, CLAUDE_CONFIG_DIR,
 *   profile selectors, and PI_CODING_AGENT_DIR; a naive `{...process.env}` copy lets
 *   the developer's exported values silently redirect a synthetic-home subprocess
 *   (and leak the real user config into it). This helper strips those selectors so
 *   the caller's overrides are the only ones in effect.
 * Public API: hermeticChildEnv(overrides?: Record<string, string>): Record<string, string>
 * Upstream deps: src/shared/env-scrub.ts, process.env
 * Downstream consumers: discovery.contract.test.ts and any future child-spawning test.
 * Failure modes: A new OMP config-root selector is still inherited until added
 *   to the canonical SCRUBBED_ENV_VARS list. Delivery-tree gates ban raw
 *   process.env spreads in tests so new call sites must come through here.
 * Performance: O(env size) copy.
 */
import { withoutScrubbedEnvVars } from "../../src/shared/env-scrub";

/**
 * Copy of process.env with every config-root/profile selector removed, then
 * `overrides` applied. Callers pass the synthetic HOME/XDG/agent-dir values (and any
 * deliberately blanked selectors) through `overrides`.
 */
export function hermeticChildEnv(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return { ...withoutScrubbedEnvVars(process.env), ...overrides };
}
