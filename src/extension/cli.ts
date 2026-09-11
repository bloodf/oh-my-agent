/**
 * Purpose: TUI `omp-agent` dispatchers. Public API: `cliCommand`,
 * `consoleCommand`. Notices handle failures; console URL stays hidden
 * until the operator picks Show URL.
 */
import { join } from "node:path";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
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
	const trimmed = args.trim();
	const argv = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
	await run(argv, {
		agentDir,
		io: {
			stdout: (text) => chunks.push(text),
			stderr: (text) => chunks.push(text),
		},
		// The shell binary reads a `-` argument from stdin; inside the TUI that
		// stdin belongs to OMP's own input loop, so the default would park the
		// session forever waiting on a stream nobody is going to close.
		readStdin: async () => {
			throw new Error(
				"stdin is unavailable inside the TUI; pass a file path instead of -.",
			);
		},
	});
	const text = chunks.join("").trimEnd();
	if (text.length > 0) io.notify(text);
}

export interface ConsoleCommandOpts {
	agentDir?: string;
	ensure?: () => Promise<unknown>;
	/** URL source; defaults to shared `console` verb. */
	fetchUrl?: (agentDir: string) => Promise<string>;
	/** Native launcher. true means dispatch accepted, not browser rendered. */
	openUrl?: (url: string) => Promise<boolean>;
	/** Clipboard write; native bridge may swallow local clipboard failures. */
	writeClipboard?: (text: string) => Promise<void>;
}
const CONSOLE_DISABLED_MESSAGE =
	"oh-my-agent console is disabled for this daemon.";
const CONSOLE_UNAVAILABLE_MESSAGE = "oh-my-agent console is unavailable.";

async function defaultFetchUrl(agentDir: string): Promise<string> {
	const chunks: string[] = [];
	const stderrs: string[] = [];
	const code = await runCli(["console"], {
		agentDir,
		io: {
			stdout: (text) => chunks.push(text),
			stderr: (text) => stderrs.push(text),
		},
	});
	if (code === 0) {
		const url = chunks.join("").trim();
		if (url.length === 0) throw new Error(CONSOLE_UNAVAILABLE_MESSAGE);
		return url;
	}
	// Only the exact daemon sentence is safe to echo; anything else
	// (which can include the URL or a path containing the token) is
	// collapsed, so a hostile Error carrying "console is disabled"
	// as a substring cannot leak a token through us.
	const stderr = stderrs.join("").trim();
	throw new Error(
		stderr === CONSOLE_DISABLED_MESSAGE
			? CONSOLE_DISABLED_MESSAGE
			: CONSOLE_UNAVAILABLE_MESSAGE,
	);
}

/** Arg-vector launcher with ignored stdio: URL contains the operator token. */
async function defaultOpenUrl(url: string): Promise<boolean> {
	const platform = process.platform;
	const argv =
		platform === "darwin"
			? ["open", url]
			: platform === "win32"
				? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];
	try {
		const child = Bun.spawn({
			cmd: [...argv],
			stdio: ["ignore", "ignore", "ignore"],
		});
		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

/** `/console`: shared console verb plus Open web UI / Copy URL / Show URL. */
export async function consoleCommand(
	io: ExtensionIO,
	opts: ConsoleCommandOpts = {},
): Promise<void> {
	const agentDir = opts.agentDir ?? getAgentDir();
	const fetchUrl = opts.fetchUrl ?? defaultFetchUrl;
	const openUrl = opts.openUrl ?? defaultOpenUrl;
	const writeClipboard =
		opts.writeClipboard ?? ((text: string) => copyToClipboard(text));

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

	let url: string;
	try {
		url = await fetchUrl(agentDir);
	} catch (error) {
		const message =
			error instanceof Error && error.message === CONSOLE_DISABLED_MESSAGE
				? CONSOLE_DISABLED_MESSAGE
				: CONSOLE_UNAVAILABLE_MESSAGE;
		io.notify(message);
		return;
	}

	// Reject non-loopback / non-http URLs before any native helper.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		io.notify(CONSOLE_UNAVAILABLE_MESSAGE);
		return;
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		(parsed.hostname !== "127.0.0.1" &&
			parsed.hostname !== "localhost" &&
			parsed.hostname !== "[::1]" &&
			parsed.hostname !== "::1")
	) {
		io.notify(CONSOLE_UNAVAILABLE_MESSAGE);
		return;
	}

	const choice = await io.select("Open the web console", [
		"Open web UI",
		"Copy URL",
		"Show URL",
	]);

	if (choice === undefined) return;

	if (choice === "Open web UI") {
		let opened = false;
		try {
			opened = await openUrl(url);
		} catch {
			// Launcher failures must not reach TUI.
		}
		if (opened) {
			io.notify("Sent web console to default browser.");
			return;
		}
		io.notify("Browser unavailable; choose Copy URL or Show URL.");
		return;
	}

	if (choice === "Copy URL") {
		try {
			await writeClipboard(url);
			io.notify("Sent console URL to clipboard.");
		} catch {
			io.notify("Could not send to clipboard; use Show URL instead.");
		}
		return;
	}

	if (choice === "Show URL") {
		io.notify(url);
	}
	// Unknown label: silent no-op.
}
