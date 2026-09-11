/**
 * Purpose: Seed the shipped staff peers into the operator's user store, so a
 * fresh install has a working team before anyone writes a definition.
 *
 * Public API: `seedDefaultPeers(options)`, `DEFAULT_PEER_DIR`.
 *
 * Upstream deps: node fs; the markdown files under `src/defaults/agents/`.
 *
 * Downstream consumers: `./runtime` at boot, when the daemon was started by
 * the real launcher rather than a test harness.
 *
 * Failure modes: a name that already exists in the user store, or that the
 * operator once deleted, is left alone — the marker file records every name
 * ever seeded, so a deletion is respected on the next boot and an edit is
 * never overwritten. A seed that cannot be written is logged and skipped;
 * it must not stop the daemon.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The shipped definitions, beside this package's source. */
export const DEFAULT_PEER_DIR = join(
	import.meta.dir,
	"..",
	"defaults",
	"agents",
);

/** Which shipped names have been offered to this store, ever. */
const MARKER_FILE = ".defaults-seeded.json";

export interface SeedDefaultPeersOptions {
	/** The user peer store root, `<agentDir>/oh-my-agent/agents`. */
	userRoot: string;
	/** Where the shipped files live; overridable for tests. */
	sourceDir?: string;
	log?: (message: string) => void;
}

interface Marker {
	seeded: string[];
}

async function readMarker(path: string): Promise<Marker> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			Array.isArray((parsed as Marker).seeded)
		) {
			return {
				seeded: (parsed as Marker).seeded.filter(
					(name): name is string => typeof name === "string",
				),
			};
		}
	} catch {
		// Absent or unreadable: nothing has been seeded here yet.
	}
	return { seeded: [] };
}

/**
 * Copy each shipped definition the store has never seen into it.
 *
 * Returns the names written this time. Write-then-rename, like the peer
 * store itself: a running daemon re-reads definitions per delivered turn, and
 * a half-written file would parse as a broken peer.
 */
export async function seedDefaultPeers(
	options: SeedDefaultPeersOptions,
): Promise<string[]> {
	const sourceDir = options.sourceDir ?? DEFAULT_PEER_DIR;
	const log = options.log ?? (() => {});
	const markerPath = join(options.userRoot, MARKER_FILE);
	const marker = await readMarker(markerPath);
	const seeded = new Set(marker.seeded);
	const written: string[] = [];

	let files: string[];
	try {
		files = (await readdir(sourceDir)).filter((f) => f.endsWith(".md")).sort();
	} catch (error) {
		log(`default peers unavailable at ${sourceDir}: ${String(error)}`);
		return written;
	}

	await mkdir(options.userRoot, { recursive: true });
	for (const file of files) {
		const name = file.slice(0, -".md".length);
		const target = join(options.userRoot, file);
		// Offered once. An existing file is the operator's, whether they
		// edited a seed or wrote their own; a missing one they deleted stays
		// deleted.
		if (seeded.has(name) || existsSync(target)) {
			seeded.add(name);
			continue;
		}
		const staging = `${target}.${process.pid}.tmp`;
		try {
			await writeFile(staging, await readFile(join(sourceDir, file), "utf8"));
			await rename(staging, target);
			seeded.add(name);
			written.push(name);
		} catch (error) {
			log(`default peer ${name} not seeded: ${String(error)}`);
		}
	}

	if (written.length > 0 || marker.seeded.length !== seeded.size) {
		await writeFile(
			markerPath,
			`${JSON.stringify({ seeded: [...seeded].sort() }, null, "\t")}\n`,
		);
	}
	if (written.length > 0) log(`seeded default peers: ${written.join(", ")}`);
	return written;
}
