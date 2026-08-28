/**
 * Purpose: Decide how a worker process is launched under §7 sandboxing —
 * probe the platform adapter first, fail closed when it is missing or the
 * platform is unsupported, and only then compile and wrap the command.
 *
 * Public API: `resolveSandboxLaunch(options): Promise<SandboxLaunch>`.
 *
 * Upstream deps: `./sandbox` (`compileSandboxPolicy`, `probeSandbox`).
 *
 * Downstream consumers: the worker lifecycle, which spawns `command` + `args`.
 *
 * Failure modes: every failure rejects rather than degrading to an unsandboxed
 * launch — a worker that silently escapes its policy is worse than one that
 * does not start. The single exception is an explicit `enabled: false`, which
 * is reported as unsandboxed so `/agents` can surface it.
 *
 * Performance: one adapter probe per launch; the gate never executes anything.
 */

import type { SandboxPolicy } from "./sandbox";
import {
	compileSandboxPolicy,
	probeSandbox,
	SANDBOX_NETWORK_UNENFORCED,
} from "./sandbox";

export interface ResolveSandboxLaunchOptions {
	policy: SandboxPolicy;
	/** Argv the worker would run unsandboxed, e.g. `["bun", "cli.js", …]`. */
	command: string[];
	platform: NodeJS.Platform;
	/** Adapter lookup; returns the resolved path or `null` when absent. */
	which: (binary: string) => Promise<string | null>;
	/**
	 * Loopback reachability check for the inference gateway. A sandbox that
	 * permits only that port is useless if nothing is listening: the worker
	 * would launch and stall on its first model call. Defaults to a real TCP
	 * connect; tests inject this seam.
	 */
	probeBridge?: (host: string, port: number) => Promise<boolean>;
	/** Agent accepted `unrestricted-host-network`. Required on Linux. */
	allowUnenforcedNetwork?: boolean;
	/** Agent opted out of sandboxing entirely. Defaults to enabled. */
	enabled?: boolean;
	/**
	 * Override the resolved adapter binary. Production uses whatever the probe
	 * found; tests substitute a runnable stand-in so the gate's full argv can
	 * be executed without a privileged sandbox.
	 */
	adapterCommand?: string;
}

export interface SandboxLaunch {
	sandboxed: boolean;
	command: string;
	args: string[];
	networkIsolation: "loopback-enforced" | "unrestricted-host-network";
	/** Visible policy downgrades, e.g. `SANDBOX_NETWORK_UNENFORCED`. */
	warnings: string[];
}

/**
 * Real loopback reachability: open a TCP connection and close it. Used unless
 * a caller injects its own probe.
 */
async function defaultBridgeProbe(
	host: string,
	port: number,
): Promise<boolean> {
	try {
		const socket = await Bun.connect({
			hostname: host,
			port,
			socket: { data() {} },
		});
		socket.end();
		return true;
	} catch {
		return false;
	}
}

export async function resolveSandboxLaunch(
	options: ResolveSandboxLaunchOptions,
): Promise<SandboxLaunch> {
	const {
		policy,
		command,
		platform,
		which,
		allowUnenforcedNetwork,
		enabled = true,
	} = options;

	const [executable, ...rest] = command;
	if (!executable)
		throw new Error("Sandbox launch requires a non-empty command");

	if (!enabled) {
		// Opted out: no probe, no wrapping, and the lack of isolation is stated
		// rather than implied.
		return {
			sandboxed: false,
			command: executable,
			args: rest,
			networkIsolation: "unrestricted-host-network",
			warnings: [],
		};
	}

	// Probe before compiling: a missing adapter must surface as an adapter
	// failure, not as whatever the compiler happens to complain about first.
	const probe = await probeSandbox(platform, which);
	if (!probe.available) throw new Error(`Sandbox unavailable: ${probe.reason}`);
	// The gateway is the worker's only route to a model; an unreachable bridge
	// means a worker that starts and immediately stalls. Always checked.
	const { host, port } = policy.inferenceGateway;
	const probeBridge = options.probeBridge ?? defaultBridgeProbe;
	if (!(await probeBridge(host, port))) {
		throw new Error(`Inference gateway unreachable at ${host}:${port}`);
	}

	const compiled = compileSandboxPolicy(policy, platform, {
		allowUnenforcedNetwork,
	});

	return {
		sandboxed: true,
		command: options.adapterCommand ?? compiled.command,
		args: [...compiled.args, ...command],
		networkIsolation: compiled.networkIsolation,
		warnings:
			compiled.networkIsolation === "unrestricted-host-network"
				? [SANDBOX_NETWORK_UNENFORCED]
				: [],
	};
}
