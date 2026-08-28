/**
 * RED tests for src/daemon/peer-store.ts
 *
 * Public API under test: createPeerStore(roots), resolvePeerStoreRoots(options)
 *
 * Architecture contract (§5.2): peer definitions load only from the plugin-private
 * user and project stores. Project definitions shadow user definitions by parsed
 * name. A malformed file is reported with its path without hiding valid peers,
 * while missing and empty stores behave like empty listings.
 *
 * Every store assertion calls createPeerStore, and both shipped examples pass
 * through the production parsePeerDefinition parser.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createPeerStore,
	type PeerStoreRoots,
	resolvePeerStoreRoots,
} from "../src/daemon/peer-store";
import { parsePeerDefinition } from "../src/shared/agent-definition";

async function withTempStore<T>(
	callback: (base: string, roots: PeerStoreRoots) => Promise<T>,
): Promise<T> {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-peer-store-"));
	const roots = {
		user: join(base, "user", "agents"),
		project: join(base, "project", "agents"),
	};
	try {
		return await callback(base, roots);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

function peerDocument(
	name: string,
	description: string,
	extra: Record<string, unknown> = {},
): string {
	const frontmatter = {
		name,
		description,
		model: "@research",
		tools: ["read", "grep"],
		spawns: ["scout"],
		...extra,
	};
	const yaml = Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	return `---\n${yaml}\n---\nYou are ${name}.`;
}

async function writePeer(
	root: string,
	filename: string,
	content: string,
): Promise<string> {
	await mkdir(root, { recursive: true });
	const path = join(root, filename);
	await writeFile(path, content, "utf8");
	return path;
}

describe("peer store", () => {
	test("enumerates both stores and project definitions shadow user definitions", async () => {
		await withTempStore(async (_base, roots) => {
			await writePeer(
				roots.user,
				"researcher.md",
				peerDocument("researcher", "User researcher."),
			);
			await writePeer(
				roots.user,
				"reviewer.md",
				peerDocument("reviewer", "User reviewer."),
			);
			await writePeer(
				roots.project,
				"project-reviewer.md",
				peerDocument("reviewer", "Project reviewer."),
			);
			await writePeer(
				roots.project,
				"implementor.md",
				peerDocument("implementor", "Project implementor."),
			);

			const store = createPeerStore(roots);
			const listing = await store.list();

			expect(listing.errors).toEqual([]);
			expect(listing.definitions.map(({ name }) => name)).toEqual([
				"implementor",
				"researcher",
				"reviewer",
			]);
			expect(
				listing.definitions.find(({ name }) => name === "reviewer")
					?.description,
			).toBe("Project reviewer.");
			expect((await store.get("reviewer"))?.description).toBe(
				"Project reviewer.",
			);
		});
	});

	test("reports a malformed definition path without aborting the listing", async () => {
		await withTempStore(async (_base, roots) => {
			await writePeer(
				roots.user,
				"valid.md",
				peerDocument("valid", "Valid peer."),
			);
			const malformedPath = await writePeer(
				roots.user,
				"malformed.md",
				"---\nname: broken\nname: duplicate\n---\nBroken peer.",
			);

			const listing = await createPeerStore(roots).list();

			expect(listing.definitions.map(({ name }) => name)).toEqual(["valid"]);
			expect(listing.errors).toHaveLength(1);
			expect(listing.errors[0]?.path).toBe(malformedPath);
			expect(listing.errors[0]?.error.message).toContain(malformedPath);
		});
	});

	test("missing and empty store directories produce empty listings", async () => {
		await withTempStore(async (_base, roots) => {
			const store = createPeerStore(roots);
			expect(await store.list()).toEqual({ definitions: [], errors: [] });

			await mkdir(roots.user, { recursive: true });
			await mkdir(roots.project, { recursive: true });
			expect(await store.list()).toEqual({ definitions: [], errors: [] });
		});
	});

	test("resolves only plugin-private roots from explicit active directories", () => {
		const roots = resolvePeerStoreRoots({
			agentDir: "/profiles/solara",
			projectDir: "/work/project",
		});

		expect(roots).toEqual({
			user: "/profiles/solara/oh-my-agent/agents",
			project: "/work/project/.omp/oh-my-agent/agents",
		});
		expect(roots.user).not.toBe("/profiles/solara/agents");
		expect(roots.project).not.toBe("/work/project/.omp/agents");
	});
});

describe("shipped peer examples", () => {
	for (const filename of ["example-researcher.md", "example-reviewer.md"]) {
		test(`${filename} parses through parsePeerDefinition`, async () => {
			const path = join(import.meta.dir, "..", "agents", filename);
			const definition = parsePeerDefinition(
				path,
				await readFile(path, "utf8"),
			);

			expect(definition.name).toBe(
				filename.replace("example-", "").slice(0, -3),
			);
			expect(definition.spawns).toBeDefined();
		});
	}

	test("example reviewer demonstrates spawn and room subscriptions", async () => {
		const path = join(import.meta.dir, "..", "agents", "example-reviewer.md");
		const definition = parsePeerDefinition(path, await readFile(path, "utf8"));

		expect(definition.spawns).toEqual(["scout", "implementor"]);
		expect(definition.rooms).toEqual(["#reviews", "#engineering"]);
	});
});
