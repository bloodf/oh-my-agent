/**
 * Purpose: The preset library — role definitions that ship with the package
 * but are never seeded. An operator, the console, the CLI, or a worker
 * copies one into a new peer under a name of their choosing.
 *
 * Public API: `PRESET_DIR`, `listPresets(dir?)`.
 *
 * Upstream deps: node fs; `../shared/agent-definition` for the same strict
 * parse a user definition gets, so a preset that would be refused at
 * `agent_create` is refused here first, by the packager's own tests.
 *
 * Downstream consumers: `./runtime` (the `presets_list` capability), and
 * through it the socket, the console's `/api/presets`, the CLI, the TUI, and
 * the worker toolbelt.
 *
 * Failure modes: a preset that fails to parse is reported with the parser's
 * words and the file name, never skipped — a broken shipped file is a
 * packaging bug, not a runtime condition to tolerate.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePeerDefinition } from "../shared/agent-definition";
import type { PresetInfo } from "../shared/protocol";

/** The shipped presets, beside this package's source. */
export const PRESET_DIR = join(import.meta.dir, "..", "defaults", "presets");

/** Every preset, sorted by name, with the fields `agent_create` accepts. */
export async function listPresets(dir = PRESET_DIR): Promise<PresetInfo[]> {
	const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
	const presets: PresetInfo[] = [];
	for (const file of files) {
		const path = join(dir, file);
		const content = await readFile(path, "utf8");
		let parsed: ReturnType<typeof parsePeerDefinition>;
		try {
			parsed = parsePeerDefinition(path, content);
		} catch (error) {
			throw new Error(
				`preset ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const name = file.slice(0, -".md".length);
		if (parsed.name !== name) {
			throw new Error(
				`preset ${file}: declares name ${JSON.stringify(parsed.name)}`,
			);
		}
		presets.push({
			name,
			description: parsed.description,
			body: parsed.body,
			spawns: parsed.spawns,
			...(parsed.rooms === undefined ? {} : { rooms: parsed.rooms }),
			...(parsed.wake === undefined ? {} : { wake: parsed.wake }),
			...(parsed.autonomy === undefined ? {} : { autonomy: parsed.autonomy }),
			...(parsed.model === undefined ? {} : { model: parsed.model }),
			...(parsed.heartbeat === undefined
				? {}
				: { heartbeat: parsed.heartbeat }),
		});
	}
	return presets;
}
