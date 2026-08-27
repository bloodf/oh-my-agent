/**
 * RED tests for src/daemon/materializer.ts
 *
 * Public API under test: materializeWorker(options) -> WorkerLayout
 *
 * Architecture contract (§5.2): the daemon builds a synthetic user root per
 * worker. That root owns HOME + all four XDG_* dirs; the canonical OMP agent
 * dir is <home>/.omp/agent, and its agents/ holds only the worker's own
 * generated native definition plus the definitions named by spawns:. The dir
 * carries no agent.db and no upstream broker/provider credentials — model
 * turns reach upstream only through the per-worker inference gateway. As
 * defense-in-depth the worker's config pins task.disabledAgents to every
 * discovered agent name outside the spawns: allowlist.
 *
 * Every peer fixture here is produced by parsePeerDefinition so the tests bind
 * to the real parser output shape rather than a hand-built struct.
 *
 * @Environment bun
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const realRename = fs.rename;

import type { PeerDefinition } from "../src/shared/agent-definition";
import { fingerprintPeerDefinition, parsePeerDefinition } from "../src/shared/agent-definition";
import { materializeWorker } from "../src/daemon/materializer";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-mat-"));
	try {
		return await fn(join(base, "worker"));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

function buildPeerDoc(frontmatter: Record<string, unknown>, body: string): string {
	const yaml = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return `---\n${yaml}\n---\n${body}`;
}

function minimalPeer(overrides: Record<string, unknown> = {}): PeerDefinition {
	return parsePeerDefinition(
		"/agents/reviewer.md",
		buildPeerDoc(
			{
				name: "reviewer",
				description: "Reviews PRs.",
				spawns: ["scout"],
				workspace: "/home/user/project",
				...overrides,
			},
			"You are the reviewer.",
		),
	);
}

function fullPeer(overrides: Record<string, unknown> = {}): PeerDefinition {
	return parsePeerDefinition(
		"/agents/reviewer.md",
		buildPeerDoc(
			{
				name: "reviewer",
				description: "Reviews PRs and posts findings.",
				model: "openai/gpt-5.4:high",
				tools: ["task", "read", "grep"],
				spawns: ["scout", "implementor"],
				workspace: "/home/user/project",
				rooms: ["#reviews", "@author"],
				wake: { mention: true, rooms: false },
				autonomy: { maxTurns: 40, budgetUsd: 2.5 },
				...overrides,
			},
			"You are the reviewer.",
		),
	);
}

const GATEWAY = { url: "http://127.0.0.1:9999", token: "inference-token" } as const;

/** Sources for every agent the fixtures name in `spawns:`. */
const DEFAULT_SPAWN_SOURCES: Record<string, string> = {
	scout: buildPeerDoc({ name: "scout", description: "Reads code." }, "You are a scout."),
	implementor: buildPeerDoc({ name: "implementor", description: "Writes code." }, "You are an implementor."),
	beta: buildPeerDoc({ name: "beta", description: "Beta agent." }, "You are beta."),
};

type MaterializeArgs = Parameters<typeof materializeWorker>[0];

/** materializeWorker with the fixture spawn sources filled in by default. */
function materialize(args: MaterializeArgs) {
	return materializeWorker({
		...args,
		sourceSpawnAgents: args.sourceSpawnAgents ?? DEFAULT_SPAWN_SOURCES,
	});
}

const AGENT_DIR_SEGMENTS = ["home", ".omp", "agent"] as const;

// ── Synthetic directory structure ───────────────────────────────────────────

describe("synthetic directory creation", () => {
	test("creates home plus all four XDG dirs", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: ["other-agent"],
				inferenceGateway: GATEWAY,
			});

			const home = join(root, "home");
			expect(result.home).toBe(home);
			expect(result.env.HOME).toBe(home);
			expect(result.env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
			expect(result.env.XDG_DATA_HOME).toBe(join(home, ".local", "share"));
			expect(result.env.XDG_STATE_HOME).toBe(join(home, ".local", "state"));
			expect(result.env.XDG_CACHE_HOME).toBe(join(home, ".cache"));

			for (const dir of [
				home,
				join(home, ".config"),
				join(home, ".local", "share"),
				join(home, ".local", "state"),
				join(home, ".cache"),
			]) {
				expect((await stat(dir)).isDirectory()).toBe(true);
			}
		});
	});

	test("agent dir is <home>/.omp/agent and is exported as PI_CODING_AGENT_DIR", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const agentDir = join(root, ...AGENT_DIR_SEGMENTS);
			expect(result.agentDir).toBe(agentDir);
			expect(result.sessionDir).toBe(join(agentDir, "sessions"));
			expect(result.env.PI_CODING_AGENT_DIR).toBe(agentDir);
		});
	});

	test("agents/ and sessions/ exist under the synthetic agent dir", async () => {
		await withTempRoot(async (root) => {
			await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const agentDir = join(root, ...AGENT_DIR_SEGMENTS);
			expect((await stat(join(agentDir, "agents"))).isDirectory()).toBe(true);
			expect((await stat(join(agentDir, "sessions"))).isDirectory()).toBe(true);
		});
	});

	test("never seeds an agent.db into the worker dir", async () => {
		await withTempRoot(async (root) => {
			await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			expect(await Bun.file(join(root, ...AGENT_DIR_SEGMENTS, "agent.db")).exists()).toBe(false);
		});
	});
});

// ── Generated native OMP definition ─────────────────────────────────────────

describe("generated native OMP definition", () => {
	test("writes the worker definition and reparses as a native agent", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: fullPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const generatedPath = join(root, ...AGENT_DIR_SEGMENTS, "agents", "reviewer.md");
			expect(result.generatedAgentPath).toBe(generatedPath);

			const content = await readFile(generatedPath, "utf8");
			const reparsed = parsePeerDefinition(generatedPath, content);
			expect(reparsed.name).toBe("reviewer");
			expect(reparsed.description).toBe("Reviews PRs and posts findings.");
			expect(reparsed.spawns).toEqual(["scout", "implementor"]);
			expect(reparsed.tools).toContain("task");
			expect(reparsed.body).toBe("You are the reviewer.");
		});
	});

	test("generated definition drops oh-my-agent private extras", async () => {
		await withTempRoot(async (root) => {
			await materialize({
				rootDir: root,
				parsedPeer: fullPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const content = await readFile(join(root, ...AGENT_DIR_SEGMENTS, "agents", "reviewer.md"), "utf8");
			const frontmatter = content.split(/^---$/m)[1] ?? "";
			for (const key of ["rooms:", "wake:", "autonomy:", "schedules:", "automations:", "workspace:"]) {
				expect(frontmatter).not.toContain(key);
			}
		});
	});

	test("materializes exactly the worker plus its spawns closure", async () => {
		await withTempRoot(async (root) => {
			await materialize({
				rootDir: root,
				parsedPeer: fullPeer(),
				discoveredAgentNames: ["other-agent"],
				inferenceGateway: GATEWAY,
				sourceSpawnAgents: {
					scout: buildPeerDoc(
						{ name: "scout", description: "Reads code." },
						"You are a scout.",
					),
					implementor: buildPeerDoc(
						{ name: "implementor", description: "Writes code." },
						"You are an implementor.",
					),
					"other-agent": buildPeerDoc(
						{ name: "other-agent", description: "Unrelated." },
						"Unrelated.",
					),
				},
			});

			const agents = join(root, ...AGENT_DIR_SEGMENTS, "agents");
			expect(await Bun.file(join(agents, "scout.md")).exists()).toBe(true);
			expect(await Bun.file(join(agents, "implementor.md")).exists()).toBe(true);
			expect(await Bun.file(join(agents, "other-agent.md")).exists()).toBe(false);
		});
	});

	test("rejects a spawns entry with no available source definition", async () => {
		await withTempRoot(async (root) => {
			await expect(
				materialize({
					rootDir: root,
					parsedPeer: fullPeer(),
					discoveredAgentNames: [],
					inferenceGateway: GATEWAY,
					sourceSpawnAgents: {
						scout: buildPeerDoc({ name: "scout", description: "Reads code." }, "Scout."),
					},
				}),
			).rejects.toThrow(/implementor/);
		});
	});
});

// ── config.yml ──────────────────────────────────────────────────────────────

describe("config generation", () => {
	test("pins maxRecursionDepth and headless approval mode", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const cfg = await readFile(result.configPath, "utf8");
			expect(cfg).toContain("maxRecursionDepth: 2");
			expect(cfg).toContain("approvalMode: yolo");
		});
	});

	test("disabledAgents is every discovered name outside spawns, sorted", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: ["zebra", "scout", "alpha", "middle"],
				inferenceGateway: GATEWAY,
			});

			expect(result.disabledAgents).toEqual(["alpha", "middle", "zebra"]);

			const cfg = await readFile(result.configPath, "utf8");
			expect(cfg.indexOf("alpha")).toBeLessThan(cfg.indexOf("middle"));
			expect(cfg.indexOf("middle")).toBeLessThan(cfg.indexOf("zebra"));
			expect(cfg).not.toContain("scout");
		});
	});

	test("spawns: '*' disables nothing", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer({ spawns: "*" }),
				discoveredAgentNames: ["alpha", "beta"],
				inferenceGateway: GATEWAY,
			});

			expect(result.disabledAgents).toEqual([]);
		});
	});
});

// ── models.yml + credential isolation ───────────────────────────────────────

describe("inference wiring", () => {
	test("models config routes through the pi-native inference gateway", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const models = await readFile(result.modelsPath, "utf8");
			expect(models).toContain("transport: pi-native");
			expect(models).toContain(`baseUrl: ${GATEWAY.url}`);
			expect(models).toContain("OH_MY_AGENT_INFERENCE_TOKEN");
			expect(models).not.toContain(GATEWAY.token);
		});
	});

	test("token reaches the worker through env only", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			expect(result.env.OH_MY_AGENT_INFERENCE_TOKEN).toBe(GATEWAY.token);
		});
	});

	test("carries no upstream broker or provider credentials", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			const leaked = Object.keys(result.env).filter(
				(k) =>
					k !== "OH_MY_AGENT_INFERENCE_TOKEN" &&
					/BROKER|API_KEY|ANTHROPIC|OPENAI|TOKEN/i.test(k),
			);
			expect(leaked).toEqual([]);
		});
	});
});

// ── WorkerLayout shape ──────────────────────────────────────────────────────

describe("WorkerLayout return shape", () => {
	test("returns fully-qualified paths contained under rootDir", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			expect(result.root).toBe(root);
			for (const p of [
				result.home,
				result.agentDir,
				result.sessionDir,
				result.generatedAgentPath,
				result.configPath,
				result.modelsPath,
			]) {
				expect(p.startsWith(root)).toBe(true);
			}
		});
	});

	test("fingerprint matches fingerprintPeerDefinition for the source peer", async () => {
		await withTempRoot(async (root) => {
			const peer = fullPeer();
			const result = await materialize({
				rootDir: root,
				parsedPeer: peer,
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			expect(result.definitionFingerprint).toBe(fingerprintPeerDefinition(peer));
		});
	});
});

// ── mcps selection ──────────────────────────────────────────────────────────

describe("mcps selection", () => {
	test("writes only the selected servers", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer({ mcps: ["kept"] }),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
				sourceMCPs: {
					kept: { command: "node", args: [join(root, "servers", "kept.js")] },
					dropped: { command: "node", args: [join(root, "servers", "dropped.js")] },
				},
			});

			expect(result.mcpPath).toBeDefined();
			const parsed = JSON.parse(await readFile(result.mcpPath as string, "utf8"));
			expect(Object.keys(parsed.mcpServers ?? parsed.mcps ?? {})).toEqual(["kept"]);
		});
	});

	test("unknown selected mcp rejects by name", async () => {
		await withTempRoot(async (root) => {
			await expect(
				materialize({
					rootDir: root,
					parsedPeer: minimalPeer({ mcps: ["unknown-mcp"] }),
					discoveredAgentNames: [],
					inferenceGateway: GATEWAY,
					sourceMCPs: {},
				}),
			).rejects.toThrow(/unknown-mcp/);
		});
	});

	test("no mcps selected leaves mcpPath undefined and writes no file", async () => {
		await withTempRoot(async (root) => {
			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});

			expect(result.mcpPath).toBeUndefined();
			expect(await Bun.file(join(root, ...AGENT_DIR_SEGMENTS, "mcp.json")).exists()).toBe(false);
		});
	});
});

// ── skills selection ────────────────────────────────────────────────────────

describe("skills selection", () => {
	test("copies the selected skill tree into <agentDir>/skills/<name>", async () => {
		await withTempRoot(async (root) => {
			const source = join(root, "..", "skill-src", "pr-review");
			await mkdir(join(source, "reference"), { recursive: true });
			await writeFile(join(source, "SKILL.md"), "# pr-review\n", "utf8");
			await writeFile(join(source, "reference", "notes.md"), "notes\n", "utf8");

			const result = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer({ skills: ["pr-review"] }),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
				sourceSkillRoots: { "pr-review": source },
			});

			const dest = join(root, ...AGENT_DIR_SEGMENTS, "skills", "pr-review");
			expect(result.skillPaths).toEqual([dest]);
			expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("# pr-review\n");
			expect(await readFile(join(dest, "reference", "notes.md"), "utf8")).toBe("notes\n");
		});
	});

	test("unknown selected skill rejects by name", async () => {
		await withTempRoot(async (root) => {
			await expect(
				materialize({
					rootDir: root,
					parsedPeer: minimalPeer({ skills: ["unknown-skill"] }),
					discoveredAgentNames: [],
					inferenceGateway: GATEWAY,
					sourceSkillRoots: {},
				}),
			).rejects.toThrow(/unknown-skill/);
		});
	});
});

// ── Containment ─────────────────────────────────────────────────────────────

describe("path traversal protection", () => {
	test("rejects a skill name that would escape the skills dir", async () => {
		await withTempRoot(async (root) => {
			await expect(
				materialize({
					rootDir: root,
					parsedPeer: minimalPeer({ skills: ["../escape"] }),
					discoveredAgentNames: [],
					inferenceGateway: GATEWAY,
					sourceSkillRoots: { "../escape": join(root, "..", "elsewhere") },
				}),
			).rejects.toThrow();
		});
	});

	test("rejects an mcp name that would escape the agent dir", async () => {
		await withTempRoot(async (root) => {
			await expect(
				materialize({
					rootDir: root,
					parsedPeer: minimalPeer({ mcps: ["../evil"] }),
					discoveredAgentNames: [],
					inferenceGateway: GATEWAY,
					sourceMCPs: { "../evil": { command: "node", args: [] } },
				}),
			).rejects.toThrow();
		});
	});
});

// ── Rebuild semantics ───────────────────────────────────────────────────────

describe("rebuild semantics", () => {
	test("re-materializing an unchanged peer reproduces identical bytes", async () => {
		await withTempRoot(async (root) => {
			const peer = minimalPeer();
			const first = await materialize({
				rootDir: root,
				parsedPeer: peer,
				discoveredAgentNames: ["alpha"],
				inferenceGateway: GATEWAY,
			});
			const beforeAgent = await readFile(first.generatedAgentPath, "utf8");
			const beforeConfig = await readFile(first.configPath, "utf8");

			const second = await materialize({
				rootDir: root,
				parsedPeer: peer,
				discoveredAgentNames: ["alpha"],
				inferenceGateway: GATEWAY,
			});

			expect(second.definitionFingerprint).toBe(first.definitionFingerprint);
			expect(await readFile(second.generatedAgentPath, "utf8")).toBe(beforeAgent);
			expect(await readFile(second.configPath, "utf8")).toBe(beforeConfig);
		});
	});

	test("changed spawns changes fingerprint and rewrites disabledAgents", async () => {
		await withTempRoot(async (root) => {
			const before = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: ["alpha", "beta"],
				inferenceGateway: GATEWAY,
			});
			expect(before.disabledAgents).toEqual(["alpha", "beta"]);

			const after = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer({ spawns: ["scout", "beta"] }),
				discoveredAgentNames: ["alpha", "beta"],
				inferenceGateway: GATEWAY,
				sourceSpawnAgents: {
					scout: buildPeerDoc({ name: "scout", description: "Reads code." }, "Scout."),
					beta: buildPeerDoc({ name: "beta", description: "Beta agent." }, "Beta."),
				},
			});

			expect(after.definitionFingerprint).not.toBe(before.definitionFingerprint);
			expect(after.disabledAgents).toEqual(["alpha"]);
			expect(await readFile(after.configPath, "utf8")).not.toContain("beta");
		});
	});

	test("rebuild drops agents no longer in the spawns closure", async () => {
		await withTempRoot(async (root) => {
			await materialize({
				rootDir: root,
				parsedPeer: fullPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
				sourceSpawnAgents: {
					scout: buildPeerDoc({ name: "scout", description: "Reads code." }, "Scout."),
					implementor: buildPeerDoc(
						{ name: "implementor", description: "Writes code." },
						"Implementor.",
					),
				},
			});
			const agents = join(root, ...AGENT_DIR_SEGMENTS, "agents");
			expect(await Bun.file(join(agents, "implementor.md")).exists()).toBe(true);

			await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
				sourceSpawnAgents: {
					scout: buildPeerDoc({ name: "scout", description: "Reads code." }, "Scout."),
				},
			});

			expect(await Bun.file(join(agents, "implementor.md")).exists()).toBe(false);
			expect(await Bun.file(join(agents, "scout.md")).exists()).toBe(true);
		});
	});

	test("a failed rebuild leaves the previous materialization intact", async () => {
		await withTempRoot(async (root) => {
			const good = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});
			const goodAgent = await readFile(good.generatedAgentPath, "utf8");
			const goodConfig = await readFile(good.configPath, "utf8");

			await expect(
				materialize({
					rootDir: root,
					parsedPeer: minimalPeer({ mcps: ["does-not-exist"] }),
					discoveredAgentNames: [],
					inferenceGateway: GATEWAY,
					sourceMCPs: {},
				}),
			).rejects.toThrow();

			expect(await readFile(good.generatedAgentPath, "utf8")).toBe(goodAgent);
			expect(await readFile(good.configPath, "utf8")).toBe(goodConfig);
		});
	});

	test("a failed directory swap restores the previous materialization", async () => {
		await withTempRoot(async (root) => {
			const good = await materialize({
				rootDir: root,
				parsedPeer: minimalPeer(),
				discoveredAgentNames: [],
				inferenceGateway: GATEWAY,
			});
			const goodAgent = await readFile(good.generatedAgentPath, "utf8");
			// Fail only the staging→agentDir swap, so the restore rename can run.
			const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (String(from).includes(".staging-")) throw new Error("simulated rename failure");
				return await realRename(from as string, to as string);
			});

			try {
				await expect(
					materialize({
						rootDir: root,
						parsedPeer: minimalPeer({ spawns: ["scout", "beta"] }),
						discoveredAgentNames: [],
						inferenceGateway: GATEWAY,
					}),
				).rejects.toThrow(/simulated rename failure/);
			} finally {
				spy.mockRestore();
			}

			expect(await readFile(good.generatedAgentPath, "utf8")).toBe(goodAgent);
		});
	});
});
