/**
 * Purpose: Run `omp-agent` verbs from the TUI so PATH is never required.
 * `/cli status` is the same dispatcher the shell binary uses.
 *
 * Public API: `cliCommand(io, args, opts?)`.
 *
 * Upstream deps: `../daemon/cli` (`runCli`), `./ensure-daemon`, `./widget`.
 *
 * Downstream consumers: `./index` (`/cli`, `/console`);
 * `tests/extension.test.ts`.
 *
 * Failure modes: daemon-down and usage errors are `runCli`'s sentences,
 * rendered as one notice. Auto-start runs first so a fresh TUI session can
 * `/cli status` without a prior `omp-agent daemon`. Spawn surprises still
 * land as the shared daemon-down sentence.
 */

import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { runCli } from "../daemon/cli";
import type { ExtensionIO } from "./commands";
import { ensureDaemon } from "./ensure-daemon";
import { createDaemonClient } from "./widget";

export interface CliCommandOpts {
	agentDir?: string;
	ensure?: () => Promise<unknown>;
	run?: typeof runCli;
}

function argvFrom(args: string): string[] {
	const trimmed = args.trim();
	return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/** `/cli <verb…>` — in-process `omp-agent` with captured stdout/stderr. */
export async function cliCommand(
	io: ExtensionIO,
	args: string,
	opts: CliCommandOpts = {},
): Promise<void> {
	const agentDir = opts.agentDir ?? getAgentDir();
	const run = opts.run ?? runCli;
	const ensure =
		opts.ensure ??
		(() =>
			ensureDaemon(
				createDaemonClient(join(agentDir, "oh-my-agent", "daemon.sock")),
			));

	try {
		await ensure();
	} catch {
		// Probe/spawn surprises must not throw into the TUI.
	}

	const chunks: string[] = [];
	await run(argvFrom(args), {
		agentDir,
		io: {
			stdout: (text) => {
				chunks.push(text);
			},
			stderr: (text) => {
				chunks.push(text);
			},
		},
	});
	const text = chunks.join("").trimEnd();
	if (text.length > 0) io.notify(text);
}
