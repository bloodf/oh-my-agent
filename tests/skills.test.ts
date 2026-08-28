/**
 * Tests for the shipped authoring skills (T-804).
 *
 * Public surface under test:
 *   (a) OMP's real skill loader discovers all three skills from the repo root
 *       treated as an extension package — via `loadSkills` with an explicit
 *       extensionRoots entry, the same path the `omp-plugins` provider uses.
 *   (b) Each SKILL.md frontmatter parses with the required name + description.
 *   (c) A peer definition selecting `skills: [omp-orchestration]` gets the
 *       real skill tree materialized into the worker root, using the same
 *       sourceSkillRoots injection seam as tests/materializer.test.ts.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { materializeWorker } from "../src/daemon/materializer";
import { parsePeerDefinition } from "../src/shared/agent-definition";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_SKILLS = [
	"omp-agent-authoring",
	"omp-subagent-authoring",
	"omp-orchestration",
] as const;

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-skills-"));
	try {
		return await fn(join(base, "worker"));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

// ── Discovery through OMP's real loader ─────────────────────────────────────

describe("OMP skill discovery from the package root", () => {
	test("loadSkills finds all three skills via the omp-plugins path", async () => {
		const result = await loadSkills({
			cwd: PACKAGE_ROOT,
			// Simulate the omp-plugins provider seeing this repo as an installed
			// extension package: explicit root, ambient sources suppressed.
			extensionRoots: {
				explicit: [PACKAGE_ROOT],
				mode: "explicit-only",
				configured: [],
				configuredLevel: "user",
			},
		});

		const byName = new Map(result.skills.map((s) => [s.name, s]));
		for (const name of EXPECTED_SKILLS) {
			const skill = byName.get(name);
			expect(skill, `skill ${name} not discovered`).toBeDefined();
			expect(typeof skill?.description).toBe("string");
			expect(skill?.description.length).toBeGreaterThan(0);
		}
	});
});

// ── Frontmatter contract ────────────────────────────────────────────────────

describe("skill frontmatter", () => {
	for (const name of EXPECTED_SKILLS) {
		test(`${name} has required name + description`, async () => {
			const filePath = join(PACKAGE_ROOT, "skills", name, "SKILL.md");
			const content = await readFile(filePath, "utf8");
			const { frontmatter } = parseFrontmatter(content, {
				location: filePath,
				level: "fatal",
				normalize: true,
			});
			expect(frontmatter.name).toBe(name);
			expect(typeof frontmatter.description).toBe("string");
			expect((frontmatter.description as string).length).toBeGreaterThan(0);
		});
	}
});

// ── Materialization of a selected skill into a worker root ─────────────────

describe("materialization", () => {
	test("a peer selecting omp-orchestration receives it in the worker root", async () => {
		await withTempRoot(async (root) => {
			const peer = parsePeerDefinition(
				"/agents/reviewer.md",
				[
					"---",
					'name: "reviewer"',
					'description: "Reviews PRs."',
					'model: "anthropic/claude-sonnet-4-5"',
					'spawns: ["scout"]',
					'skills: ["omp-orchestration"]',
					"---",
					"You are the reviewer.",
				].join("\n"),
			);

			const result = await materializeWorker({
				rootDir: root,
				parsedPeer: peer,
				discoveredAgentNames: [],
				inferenceGateway: {
					url: "http://127.0.0.1:9999",
					token: "inference-token",
				},
				sourceSpawnAgents: {
					scout: [
						"---",
						'name: "scout"',
						'description: "Reads code."',
						"---",
						"You are a scout.",
					].join("\n"),
				},
				sourceSkillRoots: {
					"omp-orchestration": join(
						PACKAGE_ROOT,
						"skills",
						"omp-orchestration",
					),
				},
			});

			const dest = join(
				root,
				"home",
				".omp",
				"agent",
				"skills",
				"omp-orchestration",
			);
			expect(result.skillPaths).toEqual([dest]);
			const materialized = await readFile(join(dest, "SKILL.md"), "utf8");
			expect(materialized).toContain("name: omp-orchestration");
		});
	});
});
