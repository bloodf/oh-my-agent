/**
 * Purpose: The skills this package ships, keyed by the name a peer selects
 * with `skills:` — the roots the materializer copies into a worker's agent
 * dir so OMP discovers them there.
 *
 * Public API: `PACKAGE_SKILLS_DIR`, `packageSkillRoots()`.
 *
 * Upstream deps: node fs; the `skills/` directory beside `src/`.
 *
 * Downstream consumers: `./runtime`, which hands the map to every
 * materialization. Before this existed the runtime handed the materializer
 * nothing, so a definition with `skills:` failed to start with "Unknown
 * skill" in production while the suite, which supplied its own roots,
 * stayed green.
 *
 * Failure modes: a missing directory is an empty map, not an error — a
 * checkout without skills still runs peers that select none.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");

/** Every `<skills>/<name>/SKILL.md` as name → directory. */
export function packageSkillRoots(
	dir = PACKAGE_SKILLS_DIR,
): Record<string, string> {
	const roots: Record<string, string> = {};
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return roots;
	}
	for (const name of names.sort()) {
		const path = join(dir, name);
		try {
			if (statSync(join(path, "SKILL.md")).isFile()) roots[name] = path;
		} catch {
			// Not a skill directory.
		}
	}
	return roots;
}
