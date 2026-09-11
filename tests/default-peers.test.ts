/**
 * The shipped staff peers: they parse, they are seeded once into a user
 * store, and the operator's edits and deletions survive later boots. Plus the
 * default-model fallback they rely on to start with no `model:` of their own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveDefaultModel,
	stripThinkingSuffix,
} from "../src/daemon/default-model";
import {
	DEFAULT_PEER_DIR,
	seedDefaultPeers,
} from "../src/daemon/default-peers";
import { listPresets } from "../src/daemon/presets";
import { parsePeerDefinition } from "../src/shared/agent-definition";
import { METHODS } from "../src/shared/protocol-schemas";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-defaults-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const STAFF = [
	"mate",
	"staff-backend",
	"staff-frontend",
	"staff-pm",
	"staff-qa",
];
const PRESETS = [
	"data-analyst",
	"debugger",
	"designer",
	"release-manager",
	"researcher",
	"reviewer",
	"security-reviewer",
	"sre",
	"tech-writer",
	"test-engineer",
];

describe("shipped staff definitions", () => {
	test("all five parse, share #team, declare no model, and spawn anything", async () => {
		const files = (await readdir(DEFAULT_PEER_DIR)).filter((f) =>
			f.endsWith(".md"),
		);
		expect(files.map((f) => f.slice(0, -3)).sort()).toEqual(STAFF);
		for (const file of files) {
			const path = join(DEFAULT_PEER_DIR, file);
			const definition = parsePeerDefinition(
				path,
				await readFile(path, "utf8"),
			);
			expect(definition.name).toBe(file.slice(0, -3));
			// The team talks in one shared room; each role also has its own.
			expect(definition.rooms).toContain("#team");
			expect(definition.rooms?.length).toBe(2);
			// No model: the operator's OMP default applies, and they pick a
			// different one per peer through the usual edit surfaces.
			expect(definition.model).toBeUndefined();
			// `spawns: "*"` so nothing depends on a task agent the operator has
			// not written — the way the examples' `scout` did.
			expect(definition.spawns).toBe("*");
			expect(definition.wake).toEqual({ mention: true, rooms: true });
			expect(definition.body.length).toBeGreaterThan(400);
		}
	});
});

describe("shipped presets", () => {
	test("every preset parses, is named by its file, and is never seeded", async () => {
		const presets = await listPresets();
		expect(presets.map((p) => p.name)).toEqual(PRESETS);
		for (const preset of presets) {
			expect(preset.description.length).toBeGreaterThan(20);
			expect(preset.body.length).toBeGreaterThan(400);
			expect(preset.spawns).toBe("*");
			expect(preset.rooms).toContain("#team");
			// No model: a copy runs on the OMP default until the operator picks.
			expect(preset.model).toBeUndefined();
			// The whole thing is an `agent_create` payload as it stands.
			const shape = METHODS.agent_create.validateParams(preset);
			expect(shape.ok).toBe(true);
		}
		// The library is a catalog, not a seed: seeding an empty store writes
		// the staff and the mate, and nothing from the presets.
		const userRoot = join(await tempDir(), "agents");
		const seeded = await seedDefaultPeers({ userRoot });
		expect(seeded.sort()).toEqual(STAFF);
		for (const name of PRESETS) expect(seeded).not.toContain(name);
	});

	test("a preset whose name disagrees with its file is refused by name", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "scout.md"),
			'---\nname: lookout\ndescription: d\nspawns: "*"\n---\nbody',
		);
		await expect(listPresets(dir)).rejects.toThrow(
			'preset scout.md: declares name "lookout"',
		);
	});
});

describe("the first mate", () => {
	test("mate is the operator's single point of contact and hires from the presets", async () => {
		const path = join(DEFAULT_PEER_DIR, "mate.md");
		const mate = parsePeerDefinition(path, await readFile(path, "utf8"));
		expect(mate.rooms).toEqual(["#bridge", "#team"]);
		// It must know the two hiring calls and both task shapes by name.
		for (const word of [
			"presets_list",
			"agent_create",
			"agent_spawn",
			"Ship",
			"Scout",
			"staff-pm",
			"staff-qa",
		]) {
			expect(mate.body).toContain(word);
		}
	});
});

describe("seedDefaultPeers", () => {
	test("seeds every shipped peer into an empty store, once", async () => {
		const userRoot = join(await tempDir(), "agents");
		const logs: string[] = [];
		const first = await seedDefaultPeers({
			userRoot,
			log: (m) => logs.push(m),
		});
		expect(first.sort()).toEqual(STAFF);
		expect(
			(await readdir(userRoot)).filter((f) => f.endsWith(".md")).sort(),
		).toEqual(STAFF.map((n) => `${n}.md`));
		expect(logs.some((line) => line.startsWith("seeded default peers:"))).toBe(
			true,
		);

		// A second boot offers nothing new.
		expect(await seedDefaultPeers({ userRoot })).toEqual([]);
	});

	test("a deleted seed stays deleted and an edited seed is not overwritten", async () => {
		const userRoot = join(await tempDir(), "agents");
		await seedDefaultPeers({ userRoot });

		await rm(join(userRoot, "staff-qa.md"));
		const edited = join(userRoot, "staff-pm.md");
		await writeFile(
			edited,
			(await readFile(edited, "utf8")).replace(
				"---\nname: staff-pm",
				'---\nname: staff-pm\nmodel: "openai/gpt-4.1"',
			),
		);

		expect(await seedDefaultPeers({ userRoot })).toEqual([]);
		expect((await readdir(userRoot)).includes("staff-qa.md")).toBe(false);
		expect(await readFile(edited, "utf8")).toContain('model: "openai/gpt-4.1"');
	});

	test("an operator's own peer with a shipped name is never replaced", async () => {
		const userRoot = join(await tempDir(), "agents");
		await mkdir(userRoot, { recursive: true });
		const own =
			'---\nname: staff-qa\ndescription: Mine.\nspawns: "*"\n---\nMy own QA.\n';
		await writeFile(join(userRoot, "staff-qa.md"), own);

		const written = await seedDefaultPeers({ userRoot });
		expect(written).not.toContain("staff-qa");
		expect(await readFile(join(userRoot, "staff-qa.md"), "utf8")).toBe(own);
	});
});

describe("default model", () => {
	test("stripThinkingSuffix drops a level but keeps slashes in the id", () => {
		expect(stripThinkingSuffix("durindoor/cx/gpt-5.6-sol:medium")).toBe(
			"durindoor/cx/gpt-5.6-sol",
		);
		expect(stripThinkingSuffix("openai/gpt-4.1")).toBe("openai/gpt-4.1");
		expect(stripThinkingSuffix("  anthropic/claude-sonnet-4-5:high ")).toBe(
			"anthropic/claude-sonnet-4-5",
		);
	});

	test("resolves OMP's default role from the agent dir, first fallback only", async () => {
		const agentDir = await tempDir();
		await writeFile(
			join(agentDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4.1:high, anthropic/claude-sonnet-4-5\n",
		);
		expect(await resolveDefaultModel(agentDir)).toBe("openai/gpt-4.1");
	});

	test("answers nothing when OMP has no provider-qualified default", async () => {
		const bare = await tempDir();
		expect(await resolveDefaultModel(bare)).toBeUndefined();
		const alias = await tempDir();
		await writeFile(
			join(alias, "config.yml"),
			"modelRoles:\n  default: smart\n",
		);
		expect(await resolveDefaultModel(alias)).toBeUndefined();
	});
});
