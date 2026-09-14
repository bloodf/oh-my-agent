/**
 * Purpose: The agent settings dialog's data rules — the definition shape the
 * daemon answers, how a draft is compared with what was loaded, and the PATCH
 * body that carries only changed fields.
 *
 * Public API: `Definition`, `THINKING_LEVELS`, `forEditing`, `buildPatch`,
 * `isBlank`, `sameValue`.
 *
 * Upstream deps: none. Field names and shapes mirror `PeerDefinition` in
 * `src/shared/agent-definition.ts` and the `definition_update` validator.
 *
 * Downstream consumers: `DefinitionDialog.tsx` and its sections.
 *
 * Failure modes: `buildPatch` throws when a draft changes the account
 * spending ceiling, which the console does not manage. Every other shape
 * error is left to the daemon, whose refusal the dialog shows verbatim.
 */

export type Schedule = { cron: string; prompt: string; room?: string };
export type Automation = { event: string; prompt: string; room?: string };
export type SandboxConfig = { enabled?: boolean; extraRoots?: string[]; allowUnenforcedNetwork?: boolean };

export type Definition = {
  description?: string;
  body?: string;
  model?: string[];
  tools?: string[];
  spawns?: string[] | "*";
  thinkingLevel?: string;
  workspace?: string;
  rooms?: string[];
  wake?: { mention?: boolean; rooms?: boolean };
  autonomy?: { maxTurns?: number; budgetUsd?: number };
  heartbeat?: { every: string; prompt?: string };
  sandbox?: boolean | SandboxConfig;
  mcps?: string[];
  skills?: string[];
  schedules?: Schedule[];
  automations?: Automation[];
  [key: string]: unknown;
};

/** The values `definition_update` accepts for `thinkingLevel`. */
export const THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

/** A field the form treats as unset: empty text, list, `false`, or an object of those. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value).every(isBlank);
  return false;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Deep equality that ignores object key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/**
 * The loaded definition as the editor shows it: without `name` and `sha256`,
 * which no edit may send, and without `autonomy.budgetUsd`, which is managed
 * outside the console.
 */
export function forEditing(loaded: Record<string, unknown>): Definition {
  const { name: _name, sha256: _sha, ...rest } = loaded;
  const definition = rest as Definition;
  if (definition.autonomy && typeof definition.autonomy === "object" && "budgetUsd" in definition.autonomy) {
    const { budgetUsd: _budget, ...autonomy } = definition.autonomy;
    return { ...definition, autonomy };
  }
  return definition;
}

/**
 * The PATCH body for a candidate definition: every top-level field whose value
 * differs from the loaded one. A field the candidate omits is unchanged, not
 * removed. The daemon replaces a top-level field whole, so a changed
 * `autonomy` carries the loaded spending ceiling forward.
 */
export function buildPatch(loaded: Record<string, unknown>, candidate: Record<string, unknown>): Record<string, unknown> {
  const loadedBudget = (loaded.autonomy as Definition["autonomy"])?.budgetUsd;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "name" || key === "sha256") continue;
    let next = value;
    if (key === "autonomy" && next && typeof next === "object" && !Array.isArray(next)) {
      const { budgetUsd, ...rest } = next as { budgetUsd?: unknown };
      if (budgetUsd !== undefined && budgetUsd !== loadedBudget) {
        throw new Error("autonomy.budgetUsd: spending ceilings are managed outside the console.");
      }
      next = loadedBudget === undefined ? rest : { ...rest, budgetUsd: loadedBudget };
    }
    if (!sameValue(loaded[key], next)) patch[key] = next;
  }
  return patch;
}
