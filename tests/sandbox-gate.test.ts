/**
 * RED tests for src/worker/launch-gate.ts
 *
 * Public API under test: `resolveSandboxLaunch(options)`.
 *
 * §7 / §10.2: a worker launches under a sandbox only after the platform
 * adapter is *probed available*. Unsupported or missing adapters fail closed —
 * the worker never silently runs unsandboxed. Linux `bwrap --share-net` cannot
 * enforce port-level loopback, so that downgrade requires the agent to
 * explicitly accept `unrestricted-host-network`, and the acceptance is
 * reported so `/agents` can surface it.
 *
 * The gate never launches anything: it returns the argv to run, so contract
 * tests validate the decision without privileged sandboxes.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";

import type { SandboxPolicy } from "../src/worker/sandbox";
import { SANDBOX_NETWORK_UNENFORCED } from "../src/worker/sandbox";
import { resolveSandboxLaunch } from "../src/worker/launch-gate";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const POLICY: SandboxPolicy = {
	workspace: "/home/user/project",
	workerHome: "/home/user/.omp/agent/oh-my-agent/workers/reviewer/home",
	runtimePaths: ["/usr/bin", "/bin"],
	inferenceGateway: { host: "127.0.0.1", port: 9999 },
	loopbackPorts: [9999],
};

const COMMAND = ["bun", "/path/to/cli.js", "--mode", "rpc"];

/** `which` stub: resolves the named binaries, misses everything else. */
function which(...available: string[]) {
	return async (binary: string) => (available.includes(binary) ? `/usr/bin/${binary}` : null);
}

/** Gateway bridge stubs. */
const reachable = async () => true;
const unreachable = async () => false;

type LaunchArgs = Parameters<typeof resolveSandboxLaunch>[0];

/** Defaults the bridge to reachable so each test states only what it varies. */
function launch(args: Omit<LaunchArgs, "probeBridge"> & Partial<Pick<LaunchArgs, "probeBridge">>) {
	return resolveSandboxLaunch({ probeBridge: reachable, ...args });
}

// ── Available adapter ────────────────────────────────────────────────────────

describe("resolveSandboxLaunch — adapter available", () => {
	test("darwin wraps the command in the compiled seatbelt profile", async () => {
		const result = await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "darwin",
			which: which("sandbox-exec"),
		});

		expect(result.sandboxed).toBe(true);
		expect(result.command).toBe("sandbox-exec");
		expect(result.networkIsolation).toBe("loopback-enforced");
		// The real command survives as the sandboxed payload.
		expect(result.args.slice(-COMMAND.length)).toEqual(COMMAND);
	});

	test("linux wraps the command in bwrap when the downgrade is accepted", async () => {
		const result = await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "linux",
			which: which("bwrap"),
			allowUnenforcedNetwork: true,
		});

		expect(result.sandboxed).toBe(true);
		expect(result.command).toBe("bwrap");
		expect(result.networkIsolation).toBe("unrestricted-host-network");
		expect(result.args.slice(-COMMAND.length)).toEqual(COMMAND);
	});

	test("the accepted downgrade is reported for /agents", async () => {
		const result = await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "linux",
			which: which("bwrap"),
			allowUnenforcedNetwork: true,
		});

		expect(result.warnings).toContain(SANDBOX_NETWORK_UNENFORCED);
	});

	test("an enforced sandbox reports no downgrade", async () => {
		const result = await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "darwin",
			which: which("sandbox-exec"),
		});

		expect(result.warnings).toEqual([]);
	});
});

// ── Fail closed ──────────────────────────────────────────────────────────────

describe("resolveSandboxLaunch — fails closed", () => {
	test("a missing adapter rejects rather than running unsandboxed", async () => {
		await expect(
			launch({
				policy: POLICY,
				command: COMMAND,
				platform: "darwin",
				which: which(),
			}),
		).rejects.toThrow(/sandbox-exec/);
	});

	test("an unsupported platform rejects", async () => {
		await expect(
			launch({
				policy: POLICY,
				command: COMMAND,
				platform: "win32",
				which: which("sandbox-exec", "bwrap"),
			}),
		).rejects.toThrow(/win32/);
	});

	test("linux rejects when the network downgrade is not accepted", async () => {
		// bwrap --share-net cannot enforce port-level loopback, so an agent that
		// has not accepted the downgrade must not launch at all.
		await expect(
			launch({
				policy: POLICY,
				command: COMMAND,
				platform: "linux",
				which: which("bwrap"),
			}),
		).rejects.toThrow(new RegExp(SANDBOX_NETWORK_UNENFORCED));
	});

	test("the probe runs before compilation", async () => {
		let probed = 0;
		await expect(
			launch({
				policy: POLICY,
				command: COMMAND,
				platform: "darwin",
				which: async () => {
					probed += 1;
					return null;
				},
			}),
		).rejects.toThrow(/sandbox-exec/);

		expect(probed).toBe(1);
	});

	test("an unreachable gateway rejects before returning launch argv", async () => {
		// A sandbox that permits only the gateway port is useless if nothing is
		// listening: the worker would start and stall on its first model call.
		await expect(
			launch({
				policy: POLICY,
				command: COMMAND,
				platform: "darwin",
				which: which("sandbox-exec"),
				probeBridge: unreachable,
			}),
		).rejects.toThrow(/127\.0\.0\.1:9999/);
	});

	test("the bridge is probed with the policy's declared gateway", async () => {
		const seen: string[] = [];
		await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "darwin",
			which: which("sandbox-exec"),
			probeBridge: async (host, port) => {
				seen.push(`${host}:${port}`);
				return true;
			},
		});

		expect(seen).toEqual(["127.0.0.1:9999"]);
	});

	test("a missing adapter rejects before the bridge is probed", async () => {
		let probedBridge = 0;
		await expect(
			launch({
				policy: POLICY,
				command: COMMAND,
				platform: "darwin",
				which: which(),
				probeBridge: async () => {
					probedBridge += 1;
					return true;
				},
			}),
		).rejects.toThrow(/sandbox-exec/);

		expect(probedBridge).toBe(0);
	});
});

// ── Explicitly disabled ──────────────────────────────────────────────────────

describe("resolveSandboxLaunch — sandbox disabled", () => {
	test("an opted-out agent runs unwrapped and is reported as unsandboxed", async () => {
		const result = await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "darwin",
			which: which(),
			enabled: false,
		});

		expect(result.sandboxed).toBe(false);
		expect(result.command).toBe(COMMAND[0]);
		expect(result.args).toEqual(COMMAND.slice(1));
		expect(result.networkIsolation).toBe("unrestricted-host-network");
	});

	test("disabling skips the probe entirely", async () => {
		let probed = 0;
		await launch({
			policy: POLICY,
			command: COMMAND,
			platform: "win32",
			which: async () => {
				probed += 1;
				return null;
			},
			enabled: false,
		});

		expect(probed).toBe(0);
	});
});
