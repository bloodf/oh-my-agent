/**
 * RED tests for src/shared/agent-definition.ts
 * Public API: parsePeerDefinition(filePath, content), fingerprintPeerDefinition(def)
 *
 * Architecture contract (§5): markdown + YAML frontmatter, delegates to OMP parseAgent,
 * oh-my-agent extensions in plain keys. Native keys: name, description, model, tools,
 * spawns, thinking/thinking-level, output, blocking, autoloadSkills, read-summarize,
 * prewalk, advisor. Extra keys: workspace, rooms, wake, autonomy, sandbox, mcps, skills,
 * schedules, automations. Unknown keys → reject. Long-lived peer requires explicit
 * non-empty spawns; task tool normalized.
 */
import { describe, expect, test } from "bun:test";
import { parsePeerDefinition, fingerprintPeerDefinition } from "../src/shared/agent-definition";

// ─── Helper ─────────────────────────────────────────────────────────────────

/** Build a markdown string with frontmatter fields + body text. */
function buildAgentDoc(frontmatter: Record<string, unknown>, body = "You are a helpful agent."): string {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

// ─── Valid full definition ────────────────────────────────────────────────────

test("parsePeerDefinition — valid full definition returns typed PeerDefinition", () => {
  const content = buildAgentDoc({
    name: "reviewer",
    description: "Reviews PRs and posts findings to #reviews.",
    model: "@review",
    tools: ["task", "read", "grep"],
    spawns: ["scout", "implementor"],
    workspace: "/home/user/project",
    rooms: ["#reviews", "@author"],
    wake: { mention: true, rooms: true },
    autonomy: { maxTurns: 40, budgetUsd: 2.5 },
    sandbox: { enabled: true, extraRoots: ["/shared/lib"] },
    mcps: ["filesystem", "github"],
    skills: ["pr-review", "code-analysis"],
    schedules: [{ cron: "0 9 * * 1", prompt: "Weekly review.", room: "#reviews" }],
    automations: [{ event: "pr.opened", prompt: "Auto-review.", room: "#reviews" }],
  }, "You are the code reviewer for this team. When woken with new messages, analyze and post findings.");

  const result = parsePeerDefinition("/agents/reviewer.md", content);

  expect(result.name).toBe("reviewer");
  expect(result.description).toBe("Reviews PRs and posts findings to #reviews.");
  expect(result.model).toEqual(["@review"]);
  expect(result.tools).toContain("yield");
  expect(result.tools).toContain("task");
  expect(result.tools).toContain("read");
  expect(result.spawns).toEqual(["scout", "implementor"]);
  expect(result.workspace).toBe("/home/user/project");
  expect(result.rooms).toEqual(["#reviews", "@author"]);
  expect(result.wake).toEqual({ mention: true, rooms: true });
  expect(result.autonomy).toEqual({ maxTurns: 40, budgetUsd: 2.5 });
  expect(result.sandbox).toEqual({ enabled: true, extraRoots: ["/shared/lib"] });
  expect(result.mcps).toEqual(["filesystem", "github"]);
  expect(result.skills).toEqual(["pr-review", "code-analysis"]);
  expect(result.schedules).toHaveLength(1);
  if (!result.schedules) throw new Error("schedules missing");
  expect(result.schedules[0].cron).toBe("0 9 * * 1");
  expect(result.automations).toHaveLength(1);
  if (!result.automations) throw new Error("automations missing");
  expect(result.automations[0].event).toBe("pr.opened");
  expect(result.body).toBe("You are the code reviewer for this team. When woken with new messages, analyze and post findings.");
});

test("parsePeerDefinition — minimal valid definition with required fields only", () => {
  const content = buildAgentDoc(
    { name: "worker", description: "Does worker things.", spawns: ["sub"] },
    "You are a worker agent.",
  );
  const result = parsePeerDefinition("/agents/worker.md", content);

  expect(result.name).toBe("worker");
  expect(result.description).toBe("Does worker things.");
  expect(result.spawns).toEqual(["sub"]);
  expect(result.workspace).toBeUndefined();
  expect(result.rooms).toBeUndefined();
  expect(result.body).toBe("You are a worker agent.");
});

test("parsePeerDefinition — preserves native OMP fields", () => {
  const content = buildAgentDoc({
    name: "scout",
    description: "Finds things.",
    model: "openai/gpt-4.1",
    tools: ["task", "grep", "read"],
    spawns: ["helper"],
    "thinking-level": "high",
    output: "md",
    blocking: false,
    autoloadSkills: ["safety"],
    "read-summarize": true,
    prewalk: "deep",
    advisor: "security",
  }, "You are a scout agent.");

  const result = parsePeerDefinition("/agents/scout.md", content);

  expect(result.name).toBe("scout");
  expect(result.description).toBe("Finds things.");
  expect(result.model).toEqual(["openai/gpt-4.1"]);
  expect(result.tools).toContain("task");
  expect(result.tools).toContain("yield");
  expect(result.tools).toContain("read");
  expect(result.tools).toContain("grep");
  expect(String(result.thinkingLevel)).toBe("high");
  expect(result.output).toBe("md");
  expect(result.blocking).toBe(false);
  expect(result.autoloadSkills).toEqual(["safety"]);
  expect(result.readSummarize).toBe(true);
  expect(result.prewalk).toBe("deep");
  expect(result.advisor).toBe("security");
});

test("parsePeerDefinition — malformed YAML frontmatter → throws (no silent fallback)", () => {
  // Duplicate key on required field produces definitively malformed YAML — parseFrontmatter fatal throw
  const content = `---\nname: broken\nname: duplicate\n---\nbody`;
  expect(() => parsePeerDefinition("/agents/broken.md", content)).toThrow();
});

test("parsePeerDefinition — kebab-case read-summarize normalized to readSummarize property", () => {
  const content = buildAgentDoc(
    { name: "rs", description: "Read-summarize test.", spawns: ["a"], "read-summarize": true },
    "You use read-summarize.",
  );
  const result = parsePeerDefinition("/agents/rs.md", content);
  expect(result.readSummarize).toBe(true);
  // Original key must not appear on result
  expect(result).not.toHaveProperty("read-summarize");
});

test("parsePeerDefinition — thinking-level: high maps to thinkingLevel high", () => {
  const content = buildAgentDoc(
    { name: "tl", description: "Thinking level test.", spawns: ["a"], "thinking-level": "high" },
    "You think at high level.",
  );
  const result = parsePeerDefinition("/agents/tl.md", content);
  expect(String(result.thinkingLevel)).toBe("high");
});

test("parsePeerDefinition — quoted colon-containing scalar description parses exactly", () => {
  const content = buildAgentDoc(
    { name: "colon", description: "This has a colon: right here.", spawns: ["a"] },
    "You have colons: in your body.",
  );
  const result = parsePeerDefinition("/agents/colon.md", content);
  expect(result.description).toBe("This has a colon: right here.");
  expect(result.body).toBe("You have colons: in your body.");
});

test("parsePeerDefinition — duplicate unknown key still rejects", () => {
  // The duplicate of an unknown key should still reject
  const content = `---\nname: dup\ndescription: Duplicate test.\nspawns: [a]\nunknown: first\nunknown: second\n---\nbody`;
  expect(() => parsePeerDefinition("/agents/dup.md", content)).toThrow(/Unknown key/);
});

// ─── task normalization ───────────────────────────────────────────────────────

test("parsePeerDefinition — explicit tools without task → task and yield auto-added", () => {
  const content = buildAgentDoc(
    { name: "lonely", description: "Lonely agent.", tools: ["read", "grep"], spawns: ["a"] },
    "You are lonely.",
  );
  const result = parsePeerDefinition("/agents/lonely.md", content);

  expect(result.tools).toContain("task");
  expect(result.tools).toContain("yield");
});

test("parsePeerDefinition — explicit tools list with task → includes task and yield (OMP normalization)", () => {
  const content = buildAgentDoc(
    { name: "rich", description: "Rich agent.", tools: ["task", "read"], spawns: ["a"] },
    "You are rich.",
  );
  const result = parsePeerDefinition("/agents/rich.md", content);

  expect(result.tools).toContain("task");
  expect(result.tools).toContain("yield");
  expect(result.tools).toContain("read");
});

test("parsePeerDefinition — no tools key → result.tools undefined (native unrestricted)", () => {
  const content = buildAgentDoc(
    { name: "bare", description: "Bare agent.", spawns: ["x"] },
    "You are bare.",
  );
  const result = parsePeerDefinition("/agents/bare.md", content);

  expect(result.tools).toBeUndefined();
});

// ─── spawns validation ────────────────────────────────────────────────────────

test("parsePeerDefinition — missing spawns → throws", () => {
  const content = buildAgentDoc({ name: "norest", description: "No rest." }, "You are unstoppable.");

  expect(() => parsePeerDefinition("/agents/norest.md", content)).toThrow(/spawns/);
});

test("parsePeerDefinition — empty spawns array → throws", () => {
  const content = buildAgentDoc({ name: "static", description: "Static.", spawns: [] }, "You are static.");

  expect(() => parsePeerDefinition("/agents/static.md", content)).toThrow(/spawns/);
});

// ─── workspace validation ─────────────────────────────────────────────────────

test("parsePeerDefinition — relative workspace → throws", () => {
  const content = buildAgentDoc(
    { name: "rel", description: "Relative.", spawns: ["a"], workspace: "./relative" },
    "You are relative.",
  );

  expect(() => parsePeerDefinition("/agents/rel.md", content)).toThrow(/workspace/);
});

test("parsePeerDefinition — absolute workspace → accepted", () => {
  const content = buildAgentDoc(
    { name: "abs", description: "Absolute.", spawns: ["a"], workspace: "/home/user/workspace" },
    "You are absolute.",
  );
  const result = parsePeerDefinition("/agents/abs.md", content);

  expect(result.workspace).toBe("/home/user/workspace");
});

test("parsePeerDefinition — sandbox extraRoots relative → throws", () => {
  const content = buildAgentDoc({
    name: "badroots",
    description: "Bad roots.",
    spawns: ["a"],
    sandbox: { enabled: true, extraRoots: ["../escape"] },
  }, "You have bad roots.");
  expect(() => parsePeerDefinition("/agents/badroots.md", content)).toThrow(/sandbox/);
});

test("parsePeerDefinition — sandbox extraRoots absolute → accepted", () => {
  const content = buildAgentDoc({
    name: "goodroots",
    description: "Good roots.",
    spawns: ["a"],
    sandbox: { enabled: true, extraRoots: ["/lib", "/usr/local/lib"] },
  }, "You have good roots.");

  const result = parsePeerDefinition("/agents/goodroots.md", content);
  expect(result.sandbox).toEqual({ enabled: true, extraRoots: ["/lib", "/usr/local/lib"] });
});

test("parsePeerDefinition — sandbox boolean true → accepted", () => {
  const content = buildAgentDoc(
    { name: "sbox", description: "Sandboxed.", spawns: ["a"], sandbox: true },
    "You are sandboxed.",
  );
  const result = parsePeerDefinition("/agents/sbox.md", content);

  expect(result.sandbox).toBe(true);
});

// ─── rooms validation ─────────────────────────────────────────────────────────

test("parsePeerDefinition — rooms entry without # or @ → throws", () => {
  const content = buildAgentDoc(
    { name: "badtalk", description: "Bad talk.", spawns: ["a"], rooms: ["general", "#good"] },
    "You talk badly.",
  );

  expect(() => parsePeerDefinition("/agents/badtalk.md", content)).toThrow(/rooms/);
});

test("parsePeerDefinition — valid rooms with # and @ → accepted", () => {
  const content = buildAgentDoc(
    { name: "chatter", description: "Chatter.", spawns: ["a"], rooms: ["#channel", "@user"] },
    "You are chatty.",
  );
  const result = parsePeerDefinition("/agents/chatter.md", content);

  expect(result.rooms).toEqual(["#channel", "@user"]);
});

// ─── unknown keys ───────────────────────────────────────────────────────────

test("parsePeerDefinition — unknown top-level key → throws", () => {
  const content = buildAgentDoc(
    { name: "stranger", description: "Strange.", spawns: ["a"], unknownField: "oops" },
    "You are strange.",
  );

  expect(() => parsePeerDefinition("/agents/stranger.md", content)).toThrow(/Unknown key/);
});

test("parsePeerDefinition — unknown key mentions the key name in error", () => {
  const content = buildAgentDoc(
    { name: "alien", description: "Alien.", spawns: ["a"], rogueKey: true },
    "You are alien.",
  );

  expect(() => parsePeerDefinition("/agents/alien.md", content)).toThrow("rogueKey");
});

test("parsePeerDefinition — nested unknown key inside wake → throws", () => {
  const content = buildAgentDoc(
    { name: "nosurprise", description: "No surprises.", spawns: ["a"], wake: { unknown: true } },
    "You have no surprises.",
  );

  expect(() => parsePeerDefinition("/agents/nosurprise.md", content)).toThrow(/Unknown key/);
});

// ─── autonomy validation ───────────────────────────────────────────────────────

test("parsePeerDefinition — negative maxTurns → throws", () => {
  const content = buildAgentDoc(
    { name: "overkill", description: "Overkill.", spawns: ["a"], autonomy: { maxTurns: -1 } },
    "You overkill.",
  );

  expect(() => parsePeerDefinition("/agents/overkill.md", content)).toThrow(/autonomy/);
});

test("parsePeerDefinition — negative budgetUsd → throws", () => {
  const content = buildAgentDoc(
    { name: "expensive", description: "Expensive.", spawns: ["a"], autonomy: { budgetUsd: -0.01 } },
    "You are expensive.",
  );

  expect(() => parsePeerDefinition("/agents/expensive.md", content)).toThrow(/autonomy/);
});

test("parsePeerDefinition — valid autonomy values → accepted", () => {
  const content = buildAgentDoc({
    name: "measured",
    description: "Measured.",
    spawns: ["a"],
    autonomy: { maxTurns: 10, budgetUsd: 1.0 },
  }, "You are measured.");

  const result = parsePeerDefinition("/agents/measured.md", content);
  expect(result.autonomy).toEqual({ maxTurns: 10, budgetUsd: 1.0 });
});

// ─── fingerprint ──────────────────────────────────────────────────────────────

test("fingerprintPeerDefinition — stable across key order", () => {
  const content1 = buildAgentDoc(
    { name: "fp", description: "Fingerprint test.", spawns: ["a"], rooms: ["#r"], workspace: "/w" },
    "You are fp.",
  );
  const content2 = buildAgentDoc(
    { spawns: ["a"], workspace: "/w", name: "fp", description: "Fingerprint test.", rooms: ["#r"] },
    "You are fp.",
  );

  const def1 = parsePeerDefinition("/a.md", content1);
  const def2 = parsePeerDefinition("/b.md", content2);

  expect(fingerprintPeerDefinition(def1)).toBe(fingerprintPeerDefinition(def2));
});

test("fingerprintPeerDefinition — changes when filePath differs (stable per content)", () => {
  const content = buildAgentDoc(
    { name: "fp", description: "Fingerprint test.", spawns: ["a"] },
    "You are fp.",
  );

  const def1 = parsePeerDefinition("/path/a.md", content);
  const def2 = parsePeerDefinition("/path/b.md", content);

  // Same content, different filePath → same fingerprint (content-driven only)
  expect(fingerprintPeerDefinition(def1)).toBe(fingerprintPeerDefinition(def2));
});

test("fingerprintPeerDefinition — changes when body text changes", () => {
  const def1 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"] }, "Body A"),
  );
  const def2 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"] }, "Body B"),
  );

  expect(fingerprintPeerDefinition(def1)).not.toBe(fingerprintPeerDefinition(def2));
});

test("fingerprintPeerDefinition — changes when behavior field changes", () => {
  const def1 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"], model: "@a" }, "You are x."),
  );
  const def2 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"], model: "@b" }, "You are x."),
  );

  expect(fingerprintPeerDefinition(def1)).not.toBe(fingerprintPeerDefinition(def2));
});

test("fingerprintPeerDefinition — changes when workspace changes", () => {
  const def1 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"], workspace: "/w1" }, "You are x."),
  );
  const def2 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"], workspace: "/w2" }, "You are x."),
  );

  expect(fingerprintPeerDefinition(def1)).not.toBe(fingerprintPeerDefinition(def2));
});

test("fingerprintPeerDefinition — changes when spawns allowlist changes", () => {
  const def1 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a"] }, "You are x."),
  );
  const def2 = parsePeerDefinition(
    "/a.md",
    buildAgentDoc({ name: "x", description: "Desc.", spawns: ["a", "b"] }, "You are x."),
  );

  expect(fingerprintPeerDefinition(def1)).not.toBe(fingerprintPeerDefinition(def2));
});


// ─── trust-boundary: workspace type ───────────────────────────────────────────

test("parsePeerDefinition — workspace non-string → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], workspace: 123 },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/workspace/i);
});

// ─── trust-boundary: rooms type ──────────────────────────────────────────────

test("parsePeerDefinition — rooms non-array → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], rooms: "not-an-array" },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/rooms/i);
});

test("parsePeerDefinition — rooms array with non-string item → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], rooms: ["#general", 42] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/rooms/i);
});

// ─── trust-boundary: wake type ───────────────────────────────────────────────

test("parsePeerDefinition — wake non-object → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], wake: "not an object" },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/wake/i);
});

test("parsePeerDefinition — wake.mention non-boolean → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], wake: { mention: "yes" } },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/wake/i);
});

test("parsePeerDefinition — wake.rooms non-boolean → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], wake: { rooms: 1 } },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/wake/i);
});


// ─── trust-boundary: autonomy type ───────────────────────────────────────────

test("parsePeerDefinition — autonomy non-object → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], autonomy: "not an object" },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/autonomy/i);
});

test.each([
  { label: "maxTurns zero", autonomy: { maxTurns: 0 } },
  { label: "maxTurns non-integer", autonomy: { maxTurns: 3.14 } },
  { label: "maxTurns string", autonomy: { maxTurns: "3" } },
])("parsePeerDefinition — autonomy invalid ($label) → throws", ({ autonomy }) => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], autonomy },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/autonomy/i);
});

test.each([
  { label: "budgetUsd zero", autonomy: { budgetUsd: 0 } },
  { label: "budgetUsd non-number", autonomy: { budgetUsd: "10.00" } },
])("parsePeerDefinition — autonomy invalid ($label) → throws", ({ autonomy }) => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], autonomy },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/autonomy/i);
});

// ─── trust-boundary: sandbox type ────────────────────────────────────────────

test("parsePeerDefinition — sandbox non-boolean and non-object → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], sandbox: 42 },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/sandbox/i);
});

test("parsePeerDefinition — sandbox.enabled non-boolean → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], sandbox: { enabled: "true" } },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/sandbox/i);
});

test("parsePeerDefinition — sandbox.extraRoots non-array → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], sandbox: { extraRoots: "/opt/roots" } },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/sandbox/i);
});

// ─── trust-boundary: mcps/skills type ────────────────────────────────────────

test.each([
  { key: "mcps", value: "not-an-array" },
  { key: "skills", value: { a: 1 } },
])("parsePeerDefinition — $key non-array → throws", ({ key, value }) => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], [key]: value },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(new RegExp(key, "i"));
});


// ─── trust-boundary: schedules item type ─────────────────────────────────────

test("parsePeerDefinition — schedules item non-object → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], schedules: ["not an object"] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/schedules/i);
});

test("parsePeerDefinition — schedules item missing cron → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], schedules: [{ prompt: "do it" }] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/schedules/i);
});

test("parsePeerDefinition — schedules item empty cron → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], schedules: [{ cron: "", prompt: "do it" }] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/schedules/i);
});

test("parsePeerDefinition — schedules valid cron syntax → accepted", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], schedules: [{ cron: "*/5 9-17 * * 1,2", prompt: "Weekday standups" }] },
    "You are correct.",
  );
  const result = parsePeerDefinition("/agents/good.md", content);
  expect(result.schedules).toHaveLength(1);
});

// ─── trust-boundary: automations item type ──────────────────────────────────

test("parsePeerDefinition — automations item non-object → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], automations: ["not an object"] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/automations/i);
});

test("parsePeerDefinition — automations item missing event → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], automations: [{ prompt: "do it" }] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/automations/i);
});

test("parsePeerDefinition — automations item empty event → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], automations: [{ event: "", prompt: "do it" }] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/automations/i);
});

test("parsePeerDefinition — automations item invalid room → throws", () => {
  const content = buildAgentDoc(
    { name: "boundary", description: "Boundary agent.", spawns: ["helper"], automations: [{ event: "on-file-change", prompt: "react", room: "no-hash" }] },
    "You are wrong.",
  );
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/automations/i);
});

// ─── trust-boundary: spawns array item type ─────────────────────────────────

test("parsePeerDefinition — spawns array containing non-string → throws", () => {
  const content = buildAgentDoc({ name: "boundary", description: "Boundary agent.", spawns: ["agent-1", 2, "agent-3"] }, "You are wrong.");
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/spawns/i);
});

// ─── trust-boundary: body whitespace ────────────────────────────────────────

test("parsePeerDefinition — body whitespace only → throws", () => {
  const content = buildAgentDoc({ name: "boundary", description: "Boundary agent.", spawns: ["helper"] }, "   \n\t  \n");
  expect(() => parsePeerDefinition("/agents/bad.md", content)).toThrow(/body/i);
});
