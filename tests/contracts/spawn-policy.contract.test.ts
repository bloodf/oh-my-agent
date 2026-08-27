/**
 * Spawn-policy contract suite — OMP 18.0.7 public API
 * @oh-my-pi/pi-coding-agent/task/spawn-policy
 *
 * Covers: resolveSpawnPolicy, isScoutSpawnable
 * Skips: resolveEffectiveSubagentPolicy — exercised via RPC integration contract suite.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveSpawnPolicy,
  isScoutSpawnable,
  DEFAULT_SPAWN_AGENT,
  type ResolvedSpawnPolicy,
} from "@oh-my-pi/pi-coding-agent/task/spawn-policy";

/** Precondition: DEFAULT_SPAWN_AGENT is "task" — unrestricted sessions delegate to "task" agent. */
test("DEFAULT_SPAWN_AGENT is 'task'", () => {
  expect(DEFAULT_SPAWN_AGENT).toBe("task");
});

// ── resolveSpawnPolicy ───────────────────────────────────────────────────────

describe("resolveSpawnPolicy", () => {
  test("undefined → unrestricted: enabled, defaultAgent=task, allowedAgents=null", () => {
    const p: ResolvedSpawnPolicy = resolveSpawnPolicy(undefined);
    expect(p.enabled).toBe(true);
    expect(p.defaultAgent).toBe("task");
    expect(p.allowedAgents).toBeNull();
    expect(p.allowedErrorText).toBeDefined();
  });

  test("null → unrestricted (same as undefined)", () => {
    const p = resolveSpawnPolicy(null);
    expect(p.enabled).toBe(true);
    expect(p.defaultAgent).toBe("task");
    expect(p.allowedAgents).toBeNull();
  });

  test("true → unrestricted", () => {
    const p = resolveSpawnPolicy(true);
    expect(p.enabled).toBe(true);
    expect(p.defaultAgent).toBe("task");
    expect(p.allowedAgents).toBeNull();
  });

  test("false → disabled: enabled=false, allowedAgents=[], denies all agents", () => {
    const p = resolveSpawnPolicy(false);
    expect(p.enabled).toBe(false);
    expect(p.allowedAgents).toEqual([]); // empty array = deny all; distinct from null (unrestricted)
    expect(p.defaultAgent).toBe("task"); // still "task" but meaningless when disabled
  });

  test("empty string → same as false (disabled)", () => {
    const p = resolveSpawnPolicy("");
    expect(p.enabled).toBe(false);
    expect(p.allowedAgents).toEqual([]);
  });

  test("single agent string → restricted: allowedAgents=[agent], defaultAgent=that agent", () => {
    const p = resolveSpawnPolicy("scout");
    expect(p.enabled).toBe(true);
    expect(p.defaultAgent).toBe("scout");
    expect(p.allowedAgents).toContain("scout");
  });

  test("CSV string → restricted: allowedAgents is the list, defaultAgent=first entry", () => {
    const p = resolveSpawnPolicy("scout,implementor,reviewer");
    expect(p.enabled).toBe(true);
    expect(p.defaultAgent).toBe("scout");
    expect(p.allowedAgents).toEqual(["scout", "implementor", "reviewer"]);
  });

  test("whitespace around CSV entries is trimmed", () => {
    const p = resolveSpawnPolicy("scout , implementor");
    expect(p.allowedAgents).toEqual(["scout", "implementor"]);
  });

  test("allowedErrorText is non-empty for restricted policy", () => {
    const p = resolveSpawnPolicy("scout");
    expect(p.allowedErrorText.length).toBeGreaterThan(0);
  });

  test("allowedPromptText present and non-empty for restricted policy", () => {
    const p = resolveSpawnPolicy("scout,implementor");
    expect(p.allowedPromptText).toBeDefined();
    expect(p.allowedPromptText ?? "").toContain("`scout`");
    expect((p.allowedPromptText ?? "").length).toBeGreaterThan(0);
  });
});

// ── isScoutSpawnable ─────────────────────────────────────────────────────────

describe("isScoutSpawnable", () => {
  test("undefined disabledAgents + unrestricted spawns → true", () => {
    expect(isScoutSpawnable(undefined, undefined)).toBe(true);
    expect(isScoutSpawnable(undefined, null)).toBe(true);
    expect(isScoutSpawnable(undefined, true)).toBe(true);
  });

  test("undefined disabledAgents + false spawns → false", () => {
    expect(isScoutSpawnable(undefined, false)).toBe(false);
  });

  test("scout in disabledAgents → false regardless of spawns", () => {
    expect(isScoutSpawnable(["scout"], "scout")).toBe(false);
    expect(isScoutSpawnable(["scout"], "scout,implementor")).toBe(false);
    expect(isScoutSpawnable(["scout"], true)).toBe(false);
  });

  test("deny-list only blocks the exact named agent; non-scout entries leave scout allowed", () => {
    // deny-list ["other"] does not mention "scout" → scout passes isScoutSpawnable
    expect(isScoutSpawnable(["other"], "scout")).toBe(true);
    // same for CSV allowlist that includes scout
    expect(isScoutSpawnable(["other"], "scout,implementor")).toBe(true);
  });

  test("scout not in disabledAgents + scout in allowlist → true", () => {
    expect(isScoutSpawnable(["implementor"], "scout")).toBe(true);
    expect(isScoutSpawnable(["implementor"], "scout,implementor")).toBe(true);
  });

  test("scout not in disabledAgents + unrestricted spawns → true", () => {
    expect(isScoutSpawnable(["implementor"], true)).toBe(true);
    expect(isScoutSpawnable(["implementor"], null)).toBe(true);
  });

  test("scout not in disabledAgents + false spawns → false", () => {
    expect(isScoutSpawnable(["implementor"], false)).toBe(false);
  });

  test("empty disabledAgents array → same as undefined", () => {
    expect(isScoutSpawnable([], "scout")).toBe(true);
    expect(isScoutSpawnable([], undefined)).toBe(true);
  });
});

// ── Behavioral: deny-list and allowlist interaction ───────────────────────────

describe("spawn policy deny-list × allowlist", () => {
  test("isScoutSpawnable: deny-list and allowlist are AND-ed", () => {
    // scout NOT in disabledAgents + scout in allowlist → allowed
    expect(isScoutSpawnable([], "scout")).toBe(true);
    // scout in disabledAgents → denied even if allowlisted
    expect(isScoutSpawnable(["scout"], "scout")).toBe(false);
    // scout NOT in disabledAgents + scout NOT in allowlist → denied
    expect(isScoutSpawnable([], "implementor")).toBe(false);
  });

  test("resolveSpawnPolicy: CSV restricted policy denies absent agents", () => {
    const p = resolveSpawnPolicy("scout,implementor");
    expect(p.allowedAgents).not.toBeNull();
    expect(p.allowedAgents).not.toContain("reviewer");
    expect(p.allowedAgents).not.toContain("task");
  });

  test("resolveSpawnPolicy: defaultAgent is first CSV entry", () => {
    const p = resolveSpawnPolicy("implementor,scout");
    expect(p.defaultAgent).toBe("implementor");
  });

  test("resolveSpawnPolicy: false disables even when agent list exists", () => {
    const p = resolveSpawnPolicy(false);
    expect(p.enabled).toBe(false);
  });
});

// ── Full preflight ───────────────────────────────────────────────────────────
// resolveEffectiveSubagentPolicy (discovery + session preflight) is exercised
// via the RPC integration contract suite, not this pure-policy contract.
//
// See: @oh-my-pi/pi-coding-agent/task/structured-subagent
