/**
 * Purpose: Platform sandbox compiler — Darwin (sandbox-exec) and Linux (bwrap).
 *          compileSandboxPolicy transforms a typed SandboxPolicy into a spawn-ready
 *          CompiledPolicy argv. probeSandbox checks adapter availability via an
 *          injected whichFn seam. No I/O in the pure compile path.
 *
 * Public API: compileSandboxPolicy(policy, platform, opts) → CompiledPolicy
 *             probeSandbox(platform, whichFn) → Promise<ProbeResult>
 *             SANDBOX_NETWORK_UNENFORCED (string constant)
 *             SandboxPolicy, CompileOptions, CompiledPolicy, ProbeResult (exports)
 *
 * Upstream deps: none (pure TypeScript; no external imports)
 *
 * Downstream consumers: worker launcher (spawns sandbox-exec/bwrap), materializer
 *
 * Failure modes: validation errors (SandboxError) on malformed policy;
 *                SANDBOX_NETWORK_UNENFORCED thrown on Linux without allowUnenforcedNetwork;
 *                probe returns { available: false, reason } for missing adapters
 *
 * Performance: O(n) in number of roots — linear array joins only
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const SANDBOX_NETWORK_UNENFORCED = "SANDBOX_NETWORK_UNENFORCED";

class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxPolicy {
  workspace: string;
  workerHome: string;
  runtimePaths: string[];
  inferenceGateway: { host: string; port: number };
  loopbackPorts: number[];
  extraRoots?: string[];
}

export interface CompileOptions {
  allowUnenforcedNetwork?: boolean;
}

export type CompiledPolicy = {
  command: string;
  args: string[];
  networkIsolation: "loopback-enforced" | "unrestricted-host-network";
};

export type ProbeResult =
  | { available: true; networkIsolation: "loopback-enforced" | "unrestricted-host-network" }
  | { available: false; reason: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PORT_MAX = 65535;
const PORT_MIN = 1;
const DANGEROUS = /[\x00\n"]/;

function validatePath(label: string, value: string): void {
  if (DANGEROUS.test(value)) {
    throw new SandboxError(`Invalid ${label}: contains NUL, newline, or quote`);
  }
  if (!value.startsWith("/")) {
    throw new SandboxError(`Invalid ${label}: must be absolute`);
  }
}

function validatePort(label: string, port: number): void {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new SandboxError(`Invalid ${label}: must be integer ${PORT_MIN}–${PORT_MAX}`);
  }
}

// ---------------------------------------------------------------------------
// Darwin profile compiler
// ---------------------------------------------------------------------------

function compileDarwin(policy: SandboxPolicy): CompiledPolicy {
  const {
    workspace,
    workerHome,
    runtimePaths,
    inferenceGateway,
    loopbackPorts,
    extraRoots = [],
  } = policy;

  validatePath("workspace", workspace);
  validatePath("workerHome", workerHome);
  for (const rt of runtimePaths) validatePath("runtimePaths entry", rt);
  for (const er of extraRoots) validatePath("extraRoots entry", er);

  if (inferenceGateway.host !== "127.0.0.1") {
    throw new SandboxError(`inferenceGateway.host must be 127.0.0.1; got "${inferenceGateway.host}"`);
  }
  validatePort("inferenceGateway.port", inferenceGateway.port);

  const ports = new Set(loopbackPorts);
  if (ports.size !== loopbackPorts.length) {
    throw new SandboxError("loopbackPorts contains duplicates");
  }
  for (const p of loopbackPorts) validatePort("loopbackPorts entry", p);

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read* (subpath "${workspace}"))`,
    `(allow file-write* (subpath "${workspace}"))`,
    `(allow file-write* (subpath "${workerHome}"))`,
    `(allow file-read* (subpath "${workerHome}"))`,
    ...runtimePaths.map((rt) => `(allow file-read* (subpath "${rt}"))`),
    ...extraRoots.map((er) => `(allow file-read* (subpath "${er}"))`),
    `(allow network-outbound (remote ip "127.0.0.1:${inferenceGateway.port}"))`,
    ...loopbackPorts.map((p) => `(allow network-outbound (remote ip "127.0.0.1:${p}"))`),
  ];

  return {
    command: "sandbox-exec",
    args: ["-p", lines.join("\n")],
    networkIsolation: "loopback-enforced",
  };
}

// ---------------------------------------------------------------------------
// Linux profile compiler (bwrap)
// ---------------------------------------------------------------------------

function compileLinux(policy: SandboxPolicy, opts: CompileOptions): CompiledPolicy {
  const { workspace, workerHome, runtimePaths, extraRoots = [] } = policy;

  if (!opts.allowUnenforcedNetwork) {
    throw new SandboxError(SANDBOX_NETWORK_UNENFORCED);
  }

  validatePath("workspace", workspace);
  validatePath("workerHome", workerHome);
  for (const rt of runtimePaths) validatePath("runtimePaths entry", rt);
  for (const er of extraRoots) validatePath("extraRoots entry", er);

  const args: string[] = [
    "--unshare-all",
    "--share-net",
    "--bind",
    workspace,
    workspace,
    "--bind",
    workerHome,
    workerHome,
  ];

  for (const rt of runtimePaths) {
    args.push("--ro-bind", rt, rt);
  }
  for (const er of extraRoots) {
    args.push("--ro-bind", er, er);
  }

  args.push("--");

  return { command: "bwrap", args, networkIsolation: "unrestricted-host-network" };
}

// ---------------------------------------------------------------------------
// compileSandboxPolicy
// ---------------------------------------------------------------------------

export function compileSandboxPolicy(
  policy: SandboxPolicy,
  platform: NodeJS.Platform,
  opts: CompileOptions = {}
): CompiledPolicy {
  switch (platform) {
    case "darwin":
      return compileDarwin(policy);
    case "linux":
      return compileLinux(policy, opts);
    default:
      throw new SandboxError(`Unsupported platform: ${platform}`);
  }
}

// ---------------------------------------------------------------------------
// probeSandbox
// ---------------------------------------------------------------------------

export async function probeSandbox(
  platform: NodeJS.Platform,
  whichFn: (binary: string) => Promise<string | null>
): Promise<ProbeResult> {
  switch (platform) {
    case "darwin": {
      const path = await whichFn("sandbox-exec");
      return path
        ? { available: true, networkIsolation: "loopback-enforced" }
        : { available: false, reason: "sandbox-exec not found" };
    }
    case "linux": {
      const path = await whichFn("bwrap");
      return path
        ? { available: true, networkIsolation: "unrestricted-host-network" }
        : { available: false, reason: "bwrap not found" };
    }
    default:
      return { available: false, reason: `Unsupported platform: ${platform}` };
  }
}
