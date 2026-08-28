/**
 * Purpose: Enumerate and parse peer definitions from oh-my-agent's private user
 * and project stores, with project definitions shadowing user definitions.
 *
 * Public API: `resolvePeerStoreRoots(options?)`, `createPeerStore(roots?)`,
 * `PeerStore.list()`, and `PeerStore.get(name)`.
 *
 * Upstream deps: `node:fs/promises`, `node:path`, `@oh-my-pi/pi-utils`
 * (`getAgentDir`), and `../shared/agent-definition` (`parsePeerDefinition`).
 *
 * Downstream consumers: daemon boot and definition-staleness checks.
 *
 * Failure modes: missing store directories are empty. Per-file read or parse
 * failures appear in `list().errors` with their source path and do not hide
 * valid peers. Other directory enumeration failures reject the operation.
 *
 * Performance: each list or lookup re-reads both stores in O(n) files so
 * definition-staleness checks always observe disk state.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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

export interface PeerStore {
	list(): Promise<PeerStoreListing>;
	get(name: string): Promise<PeerDefinition | undefined>;
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
	};
}
