/**
 * Purpose: Enumerate, parse, and write peer definitions in oh-my-agent's private
 * user and project stores, with project definitions shadowing user definitions.
 *
 * Public API: `resolvePeerStoreRoots(options?)`, `createPeerStore(roots?)`,
 * `PeerStore.list()`, `PeerStore.get(name)`, and `PeerStore.write(fields)`.
 *
 * Upstream deps: `node:fs/promises`, `node:path`, `node:crypto`,
 * `@oh-my-pi/pi-utils` (`getAgentDir`), and `../shared/agent-definition`
 * (`parsePeerDefinition`).
 *
 * Downstream consumers: daemon boot, definition-staleness checks, and the
 * console API, which creates and edits definitions on an operator's behalf.
 *
 * Failure modes: missing store directories are empty. Per-file read or parse
 * failures appear in `list().errors` with their source path and do not hide
 * valid peers. Other directory enumeration failures reject the operation.
 * `write` rejects with the parser's own error when the rendered document does
 * not parse, and lands nothing — a file the daemon would later refuse is worse
 * than a refused write.
 *
 * Performance: each list or lookup re-reads both stores in O(n) files so
 * definition-staleness checks always observe disk state. A write is one
 * temporary file, one `rename`, and one parse.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { getAgentDir } from "@oh-my-pi/pi-utils";

import {
	type PeerDefinition,
	parsePeerDefinition,
} from "../shared/agent-definition";

export interface PeerStoreRoots {
	user: string;
	project: string;
}

export interface ResolvePeerStoreRootsOptions {
	/** Active OMP agent directory, honoring PI_CONFIG_DIR and profiles. */
	agentDir?: string;
	/** Project whose private `.omp/oh-my-agent/agents` store is loaded. */
	projectDir?: string;
}

export interface PeerStoreFailure {
	path: string;
	error: Error;
}

export interface PeerStoreListing {
	definitions: PeerDefinition[];
	errors: PeerStoreFailure[];
}

/**
 * The definition to write, as frontmatter fields plus a body.
 *
 * Deliberately the parsed shape rather than raw markdown: the console composes
 * fields, and rendering here is what keeps a UI-created peer byte-comparable
 * with a hand-written one after both round-trip through the parser.
 */
export interface PeerDefinitionFields
	extends Partial<
		Omit<PeerDefinition, "name" | "body" | "sha256" | "filePath">
	> {
	name: string;
	body: string;
}

export interface PeerStore {
	list(): Promise<PeerStoreListing>;
	get(name: string): Promise<PeerDefinition | undefined>;
	/**
	 * Render, validate, and atomically write one definition into the project
	 * store, returning it as the parser read it back.
	 *
	 * Throws the parser's own error when the document does not parse, before
	 * anything lands.
	 */
	write(
		fields: PeerDefinitionFields,
		options?: { overwrite?: boolean },
	): Promise<PeerDefinition>;
}

export function resolvePeerStoreRoots(
	options: ResolvePeerStoreRootsOptions = {},
): PeerStoreRoots {
	const agentDir = options.agentDir ?? getAgentDir();
	const projectDir = options.projectDir ?? process.cwd();
	return {
		user: join(agentDir, "oh-my-agent", "agents"),
		project: join(projectDir, ".omp", "oh-my-agent", "agents"),
	};
}

async function markdownPaths(root: string): Promise<string[]> {
	try {
		return (await readdir(root))
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => join(root, name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function reportedFailure(path: string, cause: unknown): PeerStoreFailure {
	const message = cause instanceof Error ? cause.message : String(cause);
	return {
		path,
		error: new Error(`Failed to load peer definition ${path}: ${message}`, {
			cause,
		}),
	};
}

/**
 * Frontmatter keys a definition round-trips through, in the order the shipped
 * examples use them. Rendering in a fixed order is what makes a UI-written
 * file diff cleanly against the hand-written one it replaces.
 */
const FRONTMATTER_KEYS = [
	"description",
	"model",
	"tools",
	"spawns",
	"thinking",
	"thinkingLevel",
	"output",
	"blocking",
	"autoloadSkills",
	"readSummarize",
	"prewalk",
	"advisor",
	"workspace",
	"rooms",
	"wake",
	"autonomy",
	"sandbox",
	"mcps",
	"skills",
	"schedules",
	"automations",
] as const;

/**
 * Render a definition as a markdown document the parser accepts.
 *
 * Values are emitted as JSON, which is valid YAML for every shape the parser
 * admits (scalars, arrays, and flat mappings) and cannot be broken by a value
 * that happens to contain a colon or a leading `@`.
 */
export function renderPeerDefinition(fields: PeerDefinitionFields): string {
	const record = fields as unknown as Record<string, unknown>;
	const lines = [`name: ${JSON.stringify(fields.name)}`];
	for (const key of FRONTMATTER_KEYS) {
		const value = record[key];
		if (value === undefined) continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	return `---\n${lines.join("\n")}\n---\n${fields.body.trim()}\n`;
}

/**
 * Reject names that could escape or corrupt the store's file layout. A peer
 * name becomes a filename verbatim, so separators, dotfiles, and NULs are
 * refused before any path is built.
 */
function assertSafePeerName(name: string): void {
	if (
		name.length === 0 ||
		name.startsWith(".") ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0")
	) {
		throw new Error(`INVALID_NAME: unsafe peer name ${JSON.stringify(name)}`);
	}
}

export function createPeerStore(
	roots: PeerStoreRoots = resolvePeerStoreRoots(),
): PeerStore {
	async function list(): Promise<PeerStoreListing> {
		const definitions = new Map<string, PeerDefinition>();
		const errors: PeerStoreFailure[] = [];

		for (const root of [roots.user, roots.project]) {
			for (const path of await markdownPaths(root)) {
				try {
					const definition = parsePeerDefinition(
						path,
						await readFile(path, "utf8"),
					);
					definitions.set(definition.name, definition);
				} catch (error) {
					errors.push(reportedFailure(path, error));
				}
			}
		}

		return {
			definitions: [...definitions.values()].sort((a, b) =>
				a.name.localeCompare(b.name),
			),
			errors,
		};
	}

	return {
		list,
		async get(name) {
			return (await list()).definitions.find(
				(definition) => definition.name === name,
			);
		},
		async write(fields, options: { overwrite?: boolean } = {}) {
			assertSafePeerName(fields.name);
			const path = join(roots.project, `${fields.name}.md`);
			// Defense in depth: even a validated name must resolve inside the
			// store root it was joined under.
			const resolvedRoot = resolve(roots.project);
			const resolvedPath = resolve(path);
			if (
				resolvedPath !== resolvedRoot &&
				!resolvedPath.startsWith(resolvedRoot + sep)
			) {
				throw new Error(`INVALID_NAME: ${fields.name} escapes the store`);
			}
			// Conflicts key on the target path, not the parsed name: a file
			// whose frontmatter names a different peer still occupies this slot.
			if (options.overwrite !== true && existsSync(path)) {
				throw new Error(`PEER_EXISTS: ${fields.name}`);
			}
			const content = renderPeerDefinition(fields);
			// Parse before writing, not after: a file the daemon would refuse
			// on its next boot must never reach the store, and the operator
			// gets the parser's own words while the form is still open.
			const definition = parsePeerDefinition(path, content);

			await mkdir(roots.project, { recursive: true });
			// Write-then-rename: `list()` re-reads the store on every call and
			// a running daemon re-reads a definition per delivered turn, so a
			// partially written file would be parsed as a broken peer.
			const staging = `${path}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				await writeFile(staging, content, "utf8");
				await rename(staging, path);
			} catch (error) {
				await unlink(staging).catch(() => {});
				throw error;
			}
			return definition;
		},
	};
}
