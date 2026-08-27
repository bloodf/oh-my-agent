/**
 * discovery.contract.test.ts
 *
 * Contract suite for `discoverAgents` from `@oh-my-pi/pi-coding-agent/task`.
 * Uses temp directories throughout; no real user config is touched.
 *
 * Behavioral notes from source analysis:
 * - `home` arg to discoverAgents does NOT re-root native user-agent discovery.
 *   Native user agents come from getConfigDirs → os.homedir(), not from `home`.
 * - `.omp/<plugin>/agents` (plugin-private) is NOT a discovery root.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid markdown agent with YAML frontmatter. */
function makeAgentMd(name: string, description = name): string {
  return `---
name: ${name}
description: ${description}
---

You are ${name}.
`;
}

/** Temp project dir with optional .omp/agents/ contents. */
async function withTempProject(agents: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "disc-proj-"));
  if (Object.keys(agents).length > 0) {
    const agentsDir = join(root, ".omp", "agents");
    await mkdir(agentsDir, { recursive: true });
    for (const [filename, content] of Object.entries(agents)) {
      await writeFile(join(agentsDir, filename), content, "utf8");
    }
  }
  return root;
}

/**
 * Temp synthetic home root for the subprocess.
 * Creates canonical structure:
 *   <home>/.omp/agent/agents/       ← user agent definitions
 *   <home>/.config/                 ← XDG_CONFIG_HOME
 *   <home>/.local/share/            ← XDG_DATA_HOME
 *   <home>/.local/state/            ← XDG_STATE_HOME
 *   <home>/.cache/                  ← XDG_CACHE_HOME
 */
async function withSyntheticHome(agentFiles: Record<string, string>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "disc-home-"));

  // Canonical user agent dir: ~/.omp/agent/agents
  const agentDir = join(home, ".omp", "agent", "agents");
  await mkdir(agentDir, { recursive: true });
  for (const [filename, content] of Object.entries(agentFiles)) {
    await writeFile(join(agentDir, filename), content, "utf8");
  }

  // XDG roots — required by native addons (pi_natives) that stat/check these paths
  await mkdir(join(home, ".config"), { recursive: true });
  await mkdir(join(home, ".local", "share"), { recursive: true });
  await mkdir(join(home, ".local", "state"), { recursive: true });
  await mkdir(join(home, ".cache"), { recursive: true });

  return home;
}

/** Cleans up temp directories. */
async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
}

// ---------------------------------------------------------------------------
// Contract: public API surface
// ---------------------------------------------------------------------------

describe("discoverAgents public API", () => {
  test("is a function exported from @oh-my-pi/pi-coding-agent/task/discovery", () => {
    expect(typeof discoverAgents).toBe("function");
  });

  test("returns { agents: AgentDefinition[], projectAgentsDir }", async () => {
    const result = await discoverAgents(tmpdir());
    expect(result).toBeTypeOf("object");
    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.projectAgentsDir === null || typeof result.projectAgentsDir === "string").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contract: projectAgentsDir points at project root's .omp/agents
// ---------------------------------------------------------------------------

describe("projectAgentsDir points at project root", () => {
  test("equals the resolved .omp/agents path of the project cwd", async () => {
    const proj = await withTempProject({ "proj-agent.md": makeAgentMd("proj-agent") });
    const result = await discoverAgents(proj);
    expect(result.projectAgentsDir).toBe(join(proj, ".omp", "agents"));
    await cleanup(proj);
  });

  test("is null when project has no .omp/agents subdirectory", async () => {
    const proj = await mkdtemp(join(tmpdir(), "disc-naked-proj-"));
    const result = await discoverAgents(proj);
    expect(result.projectAgentsDir).toBeNull();
    await cleanup(proj);
  });
});

// ---------------------------------------------------------------------------
// Contract: plugin-private .omp/<plugin>/agents is NOT a discovery root
// ---------------------------------------------------------------------------

describe(".omp/<plugin>/agents is NOT a discovery root", () => {
  test("agent under .omp/oh-my-agent/agents is not discovered", async () => {
    const proj = await mkdtemp(join(tmpdir(), "disc-plugin-proj-"));
    const privateDir = join(proj, ".omp", "oh-my-agent", "agents");
    await mkdir(privateDir, { recursive: true });
    await writeFile(join(privateDir, "private-agent.md"), makeAgentMd("private-agent"), "utf8");

    const result = await discoverAgents(proj);

    expect(result.agents.find(a => a.name === "private-agent")).toBeUndefined();
    await cleanup(proj);
  });

  test("public .omp/agents agent is discovered; plugin-private is not", async () => {
    const proj = await mkdtemp(join(tmpdir(), "disc-plugin-proj2-"));

    const publicDir = join(proj, ".omp", "agents");
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, "public-agent.md"), makeAgentMd("public-agent"), "utf8");

    const privateDir = join(proj, ".omp", "oh-my-agent", "agents");
    await mkdir(privateDir, { recursive: true });
    await writeFile(join(privateDir, "private-agent.md"), makeAgentMd("private-agent"), "utf8");

    const result = await discoverAgents(proj);

    expect(result.agents.find(a => a.name === "public-agent")).toBeDefined();
    expect(result.agents.find(a => a.name === "private-agent")).toBeUndefined();
    await cleanup(proj);
  });
});

// ---------------------------------------------------------------------------
// Contract: valid markdown + frontmatter required for discovery
// ---------------------------------------------------------------------------

describe("agent file format requirements", () => {
  test("valid markdown agent with frontmatter is discovered", async () => {
    const proj = await withTempProject({ "valid.md": makeAgentMd("valid-agent") });
    const result = await discoverAgents(proj);
    expect(result.agents.find(a => a.name === "valid-agent")).toBeDefined();
    await cleanup(proj);
  });

  test("file without frontmatter is silently skipped (no throw)", async () => {
    const proj = await withTempProject({ "no-frontmatter.md": "You are a plain agent." });
    const result = await discoverAgents(proj);
    expect(result.agents.find(a => a.name === "no-frontmatter")).toBeUndefined();
    await cleanup(proj);
  });
});

// ---------------------------------------------------------------------------
// Subprocess contract: synthetic worker with canonical XDG + user agent layout
//
// Child environment:
//   HOME               = <synthetic home>  (drives os.homedir() → getConfigDirs)
//   XDG_CONFIG_HOME   = <synthetic home>/.config
//   XDG_DATA_HOME     = <synthetic home>/.local/share
//   XDG_STATE_HOME    = <synthetic home>/.local/state
//   XDG_CACHE_HOME    = <synthetic home>/.cache
//   PI_CODING_AGENT_DIR = <synthetic home>/.omp/agent
//   OMP_PROFILE / PI_PROFILE = ""  (blanked to prevent profile agent leaking)
//
// Child cwd = contract worktree (import.meta.dir) for node_modules / native resolution.
// Child calls discoverAgents(<tempProjectPath>) so project discovery is isolated;
// user agents come from <syntheticHome>/.omp/agent/agents/ via os.homedir().
//
// Layout under <synthetic home>:
//   .omp/agent/agents/user.md        ← user-only agent (must appear)
//   .omp/agent/agents/duplicate.md   ← user duplicate (shadowed by project)
//   .omp/agents/duplicate.md         ← project duplicate (wins)
//   .omp/oh-my-agent/agents/priv.md  ← plugin-private (must be absent)
// ---------------------------------------------------------------------------

describe("subprocess: synthetic worker — canonical layout", () => {
  test(
    "user-only present; project duplicate wins; plugin-private absent; exact projectAgentsDir",
    async () => {
      const syntheticHome = await withSyntheticHome({
        "user.md": makeAgentMd("user", "from synthetic home user"),
        "duplicate.md": makeAgentMd("duplicate", "from-synthetic-home"),
      });

      const proj = await withTempProject({});

      try {
        // project duplicate: same name, different description — project must win
        const projAgentsDir = join(proj, ".omp", "agents");
        await mkdir(projAgentsDir, { recursive: true });
        await writeFile(
          join(projAgentsDir, "duplicate.md"),
          makeAgentMd("duplicate", "from-project"),
        );

        // plugin-private under project (must NOT appear)
        const privateDir = join(proj, ".omp", "oh-my-agent", "agents");
        await mkdir(privateDir, { recursive: true });
        await writeFile(
          join(privateDir, "priv.md"),
          makeAgentMd("priv", "should-not-appear"),
        );

        const bunPath = process.execPath;
        const projCwd = proj.replace(/'/g, "\\'");
        const homeEscaped = syntheticHome.replace(/'/g, "\\'");
        const worktreeCwd = import.meta.dir;

        const childEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        childEnv["HOME"] = homeEscaped;
        childEnv["XDG_CONFIG_HOME"] = join(homeEscaped, ".config");
        childEnv["XDG_DATA_HOME"] = join(homeEscaped, ".local", "share");
        childEnv["XDG_STATE_HOME"] = join(homeEscaped, ".local", "state");
        childEnv["XDG_CACHE_HOME"] = join(homeEscaped, ".cache");
        childEnv["PI_CODING_AGENT_DIR"] = join(homeEscaped, ".omp", "agent");
        childEnv["OMP_PROFILE"] = "";
        childEnv["PI_PROFILE"] = "";
        delete childEnv["OMP_PROFILE_DIR"];
        delete childEnv["PI_PROFILE_DIR"];

        const child = Bun.spawn({
          cmd: [
            bunPath,
            "-e",
            `import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery'; const r = await discoverAgents('${projCwd}'); process.stdout.write(JSON.stringify({ agents: r.agents.map(({name, source, description}) => ({name, source, description})), projectAgentsDir: r.projectAgentsDir }));`,
          ],
          env: childEnv,
          cwd: worktreeCwd,
        });

        const exitCode = await child.exited;
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();

        if (exitCode !== 0) {
          throw new Error(
            `Child exited non-zero (${exitCode}).\nChild stdout: ${stdout}\nChild stderr: ${stderr}`,
          );
        }

        let parsed: {
          agents: Array<{ name: string; source: string; description: string }>;
          projectAgentsDir: string | null;
        };
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw new Error(
            `Child stdout not JSON.\nChild stdout: ${stdout}\nChild stderr: ${stderr}`,
          );
        }

        // user-only agent must be present (from synthetic HOME/.omp/agent/agents/user.md)
        expect(parsed.agents.find(a => a.name === "user")).toBeDefined();

        // project duplicate must win (source=project, description=from-project)
        const dup = parsed.agents.find(a => a.name === "duplicate");
        expect(dup).toBeDefined();
        expect(dup!.source).toBe("project");
        expect(dup!.description).toBe("from-project");

        // plugin-private must be absent
        expect(parsed.agents.find(a => a.name === "priv")).toBeUndefined();

        // projectAgentsDir must be the exact resolved path
        expect(parsed.projectAgentsDir).toBe(join(proj, ".omp", "agents"));
      } finally {
        await cleanup(syntheticHome, proj);
      }
    },
  );
});
