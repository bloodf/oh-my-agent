import { describe, expect, test } from "bun:test";
import {
  compileSandboxPolicy,
  probeSandbox,
  SANDBOX_NETWORK_UNENFORCED,
  type SandboxPolicy,
} from "../src/worker/sandbox";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function hasTriplet(args: string[], flag: string, path: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === path) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_POLICY: SandboxPolicy = {
  workspace: "/home/user/project",
  workerHome: "/home/user/.omp/agent/oh-my-agent/workers/test-worker/home",
  runtimePaths: ["/nix/store/abc-bun/bun", "/nix/store/xyz-node/node"],
  inferenceGateway: { host: "127.0.0.1", port: 18792 },
  loopbackPorts: [18793],
  extraRoots: ["/mnt/shared-libs"],
};

// ---------------------------------------------------------------------------
// Darwin — compileSandboxPolicy
// ---------------------------------------------------------------------------

describe("compileSandboxPolicy darwin", () => {
  test("command is sandbox-exec", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.command).toBe("sandbox-exec");
  });

  test("args[0] is -p flag", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.args[0]).toBe("-p");
  });

  test("args[1] is inline profile string", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(typeof result.args[1]).toBe("string");
    expect(result.args[1].length).toBeGreaterThan(0);
  });

  test("profile denies default network", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    const profile: string = result.args[1];
    expect(profile.toLowerCase()).toMatch(/deny.*network/);
  });

  test("profile allows workspace", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.args[1]).toContain(VALID_POLICY.workspace);
  });

  test("profile allows workerHome", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.args[1]).toContain(VALID_POLICY.workerHome);
  });

  test("profile grants file-write scoped to workspace", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    const profile: string = result.args[1];
    expect(profile).toContain(`(allow file-write* (subpath "${VALID_POLICY.workspace}"))`);
  });

  test("profile grants file-write scoped to workerHome", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    const profile: string = result.args[1];
    expect(profile).toContain(`(allow file-write* (subpath "${VALID_POLICY.workerHome}"))`);
  });

  test("profile does not grant file-write to runtimePaths", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    const profile: string = result.args[1];
    for (const rt of VALID_POLICY.runtimePaths) {
      const linesWithPath = profile.split("\n").filter((l) => l.includes(rt));
      for (const line of linesWithPath) {
        expect(line).not.toMatch(/file-write/);
      }
    }
  });

  test("profile does not grant file-write to extraRoots", () => {
    const policy = { ...VALID_POLICY, extraRoots: ["/mnt/extra"] };
    const result = compileSandboxPolicy(policy, "darwin", {});
    const profile: string = result.args[1];
    const linesWithExtra = profile.split("\n").filter((l) => l.includes("/mnt/extra"));
    for (const line of linesWithExtra) {
      expect(line).not.toMatch(/file-write/);
    }
  });

  test("profile allows extraRoots", () => {
    const policy = { ...VALID_POLICY, extraRoots: ["/mnt/extra"] };
    const result = compileSandboxPolicy(policy, "darwin", {});
    expect(result.args[1]).toContain("/mnt/extra");
  });
  test("profile allows inference gateway host 127.0.0.1", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.args[1]).toContain(VALID_POLICY.inferenceGateway.host);
  });

  test("profile allows inference gateway port", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.args[1]).toContain(String(VALID_POLICY.inferenceGateway.port));
  });

  test("profile allows each loopback port", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    const profile: string = result.args[1];
    for (const port of VALID_POLICY.loopbackPorts) {
      expect(profile).toContain(String(port));
    }
  });

  test("profile does not contain blanket allow network", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.args[1]).not.toMatch(/(default|any)\s+allow\s+network/i);
  });

  test("networkIsolation is loopback-enforced", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.networkIsolation).toBe("loopback-enforced");
  });

  test("command has no path prefix", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(result.command).toBe("sandbox-exec");
    expect(result.command).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// Linux — compileSandboxPolicy
// ---------------------------------------------------------------------------

describe("compileSandboxPolicy linux", () => {
  test("default throws SANDBOX_NETWORK_UNENFORCED", () => {
    expect(() => compileSandboxPolicy(VALID_POLICY, "linux", {})).toThrow(
      SANDBOX_NETWORK_UNENFORCED
    );
  });

  test("allowUnenforcedNetwork:true returns bwrap", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(result.command).toBe("bwrap");
  });

  test("networkIsolation is unrestricted-host-network", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(result.networkIsolation).toBe("unrestricted-host-network");
  });

  test("args include --unshare-all", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(result.args).toContain("--unshare-all");
  });

  test("args include --share-net", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(result.args).toContain("--share-net");
  });

  test("runtime paths use --ro-bind as adjacent triplet", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    for (const rt of VALID_POLICY.runtimePaths) {
      expect(hasTriplet(result.args, "--ro-bind", rt)).toBe(true);
    }
  });

  test("workspace uses --bind as adjacent triplet", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(hasTriplet(result.args, "--bind", VALID_POLICY.workspace)).toBe(true);
  });

  test("workerHome uses --bind as adjacent triplet", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(hasTriplet(result.args, "--bind", VALID_POLICY.workerHome)).toBe(true);
  });

  test("extraRoots use --ro-bind as adjacent triplet when present", () => {
    const policy = { ...VALID_POLICY, extraRoots: ["/mnt/extra"] };
    const result = compileSandboxPolicy(policy, "linux", {
      allowUnenforcedNetwork: true,
    });
    expect(hasTriplet(result.args, "--ro-bind", "/mnt/extra")).toBe(true);
  });

  test("unsupported platform throws", () => {
    expect(() =>
      compileSandboxPolicy(VALID_POLICY, "freebsd" as "linux", {
        allowUnenforcedNetwork: true,
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe("path safety", () => {
  test("workspace with NUL throws", () => {
    const bad = { ...VALID_POLICY, workspace: "/home/user/bad\x00path" };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("workspace with newline throws", () => {
    const bad = { ...VALID_POLICY, workspace: "/home/user/bad\npath" };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("workspace with double quote throws", () => {
    const bad = { ...VALID_POLICY, workspace: '/home/user/"bad"' };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("workerHome with NUL throws", () => {
    const bad = { ...VALID_POLICY, workerHome: "/home/user/bad\x00home" };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("workerHome with quote throws", () => {
    const bad = { ...VALID_POLICY, workerHome: '/home/user/"bad"' };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("runtimePath with newline throws", () => {
    const bad = { ...VALID_POLICY, runtimePaths: ["/bin/sh\nmalicious"] };
    expect(() =>
      compileSandboxPolicy(bad, "linux", { allowUnenforcedNetwork: true })
    ).toThrow();
  });

  test("extraRoot with quote throws", () => {
    const bad = { ...VALID_POLICY, extraRoots: ['/mnt/"; rm -rf /'] };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("inferenceGateway host with newline throws", () => {
    const bad = {
      ...VALID_POLICY,
      inferenceGateway: { host: "127.0.0.1\nmalicious", port: 18792 },
    };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("inferenceGateway port negative throws", () => {
    const bad = { ...VALID_POLICY, inferenceGateway: { host: "127.0.0.1", port: -1 } };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("inferenceGateway port out of range throws", () => {
    const bad = { ...VALID_POLICY, inferenceGateway: { host: "127.0.0.1", port: 70000 } };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("non-loopback gateway host throws", () => {
    const bad = { ...VALID_POLICY, inferenceGateway: { host: "10.0.0.1", port: 18792 } };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("loopbackPorts with out-of-range port throws", () => {
    const bad = { ...VALID_POLICY, loopbackPorts: [70000] };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("loopbackPorts with negative port throws", () => {
    const bad = { ...VALID_POLICY, loopbackPorts: [-1] };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });

  test("loopbackPorts with duplicate port throws", () => {
    const bad = { ...VALID_POLICY, loopbackPorts: [18793, 18793] };
    expect(() => compileSandboxPolicy(bad, "darwin", {})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// probeSandbox
// ---------------------------------------------------------------------------

describe("probeSandbox darwin", () => {
  test("returns available:true when sandbox-exec found", async () => {
    const result = await probeSandbox("darwin", async () => "/usr/bin/sandbox-exec");
    expect(result.available).toBe(true);
  });

  test("networkIsolation is loopback-enforced on darwin", async () => {
    const result = await probeSandbox("darwin", async () => "/usr/bin/sandbox-exec");
    const r = result as { available: true; networkIsolation: string };
    expect(r.networkIsolation).toBe("loopback-enforced");
  });

  test("returns available:false when not found", async () => {
    const result = await probeSandbox("darwin", async () => null);
    expect(result.available).toBe(false);
  });

  test("available:false includes reason string", async () => {
    const result = await probeSandbox("darwin", async () => null);
    const r = result as { available: false; reason: string };
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("probeSandbox linux", () => {
  test("returns available:true when bwrap found", async () => {
    const result = await probeSandbox("linux", async () => "/usr/bin/bwrap");
    expect(result.available).toBe(true);
  });

  test("networkIsolation is unrestricted-host-network on linux", async () => {
    const result = await probeSandbox("linux", async () => "/usr/bin/bwrap");
    const r = result as { available: true; networkIsolation: string };
    expect(r.networkIsolation).toBe("unrestricted-host-network");
  });

  test("returns available:false when not found", async () => {
    const result = await probeSandbox("linux", async () => null);
    expect(result.available).toBe(false);
  });

  test("available:false includes reason string", async () => {
    const result = await probeSandbox("linux", async () => null);
    const r = result as { available: false; reason: string };
    expect(r.reason.length).toBeGreaterThan(0);
  });
});


// ---------------------------------------------------------------------------
// Snapshot: result shape
// ---------------------------------------------------------------------------

describe("snapshot: compiled policy shape", () => {
  test("result has exactly command, args, networkIsolation keys", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["args", "command", "networkIsolation"]);
  });

  test("args is non-empty string array", () => {
    const result = compileSandboxPolicy(VALID_POLICY, "darwin", {});
    expect(Array.isArray(result.args)).toBe(true);
    expect(result.args.length).toBeGreaterThan(0);
    expect(result.args.every((a) => typeof a === "string")).toBe(true);
  });
});
