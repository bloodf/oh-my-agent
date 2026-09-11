/**
 * Purpose: The model a peer runs on when its definition declares none —
 * OMP's own default model role, which the operator already picks with
 * `/model` and can change at any time.
 *
 * Public API: `resolveDefaultModel(agentDir)`, `stripThinkingSuffix(value)`.
 *
 * Upstream deps: `@oh-my-pi/pi-coding-agent/config/settings` (read-only load).
 *
 * Downstream consumers: `./runtime`, once at boot.
 *
 * Failure modes: returns `undefined` when OMP has no default role or the
 * settings cannot be read; the peer then fails to start with the same
 * "declares no model" message it always had, which `status` now reports.
 * The role's `:thinking` suffix is dropped: the worker's gateway routes by
 * `provider/id` and applies no thinking level of its own.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/** `provider/model:level` → `provider/model`; anything else unchanged. */
export function stripThinkingSuffix(value: string): string {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	const colon = trimmed.lastIndexOf(":");
	return colon > slash ? trimmed.slice(0, colon) : trimmed;
}

export async function resolveDefaultModel(
	agentDir: string,
): Promise<string | undefined> {
	let configured: string | undefined;
	try {
		const settings = await Settings.loadReadOnly({ agentDir });
		configured = settings.getModelRole("default");
	} catch {
		return undefined;
	}
	if (configured === undefined) return undefined;
	// A role may list fallbacks separated by commas; the first is the choice.
	const first = configured.split(",")[0];
	if (first === undefined) return undefined;
	const selector = stripThinkingSuffix(first);
	// Only a provider-qualified selector routes through the worker gateway.
	return selector.includes("/") ? selector : undefined;
}
