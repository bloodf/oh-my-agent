/**
 * Purpose: The OMP extension entry point (§4.5) — registers the operator
 * commands and wires the status widget. Load-time work is registration only:
 * OMP's runtime actions throw `ExtensionRuntimeNotInitializedError` before
 * session start, so every socket call lives inside a handler.
 *
 * Public API: the default-exported `ExtensionFactory`.
 *
 * Upstream deps: `./commands` (command logic), `./widget` (client +
 * refresh), `./ensure-daemon` (session-start auto-start). Socket calls and
 * the daemon spawn live inside handlers, never at load.
 *
 * Downstream consumers: OMP's extension loader (`omp.extensions` in
 * package.json).
 *
 * Failure modes: command handlers render errors as notices through the
 * `ExtensionIO` adapter; nothing throws into the TUI. Session start starts
 * the detached daemon from the plugin tree if the socket is down, then
 * paints the widget. `/cli` and `/console` run the same dispatcher as the
 * shell binary, so PATH is never required. No keybindings are registered:
 * every surface is a slash command. A spawn that fails still paints
 * the shared daemon-down sentence. Turn-end refreshes only — it does not
 * restart a daemon the operator just stopped.
 */

import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
/** `getAgentDir()` from pi-utils resolves the active profile's agent dir. */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { StatusResult } from "../shared/protocol";
import { PACKAGE_VERSION } from "../shared/version";
import { cliCommand, consoleCommand } from "./cli";
import type { DaemonClient, ExtensionIO } from "./commands";
import {
	injectCommand,
	killCommand,
	logsCommand,
	presetCommand,
	roomsCreateCommand,
	roomsMembershipCommand,
	roomsPostCommand,
	roomsReadCommand,
	scheduleArmCommand,
	scheduleListCommand,
	spawnCommand,
} from "./commands";
import { ensureDaemon } from "./ensure-daemon";
import type { ManagerHostContext } from "./manager";
import { openManager } from "./manager";
import { themeFrom } from "./theme";
import { createDaemonClient, markRoomsRead, refreshWidget } from "./widget";

/** Adapt OMP's UI context onto the seam the commands are written against. */
function ioFrom(ui: ExtensionUIContext): ExtensionIO {
	return {
		notify: (message) => ui.notify(message),
		// A renderer becomes a component factory, so the widget is drawn with
		// the theme the host hands over at render time — the operator's
		// palette and symbol preset, not ours.
		setWidget: (key, content) =>
			ui.setWidget(
				key,
				typeof content === "function"
					? (_tui, theme) => ({ render: () => content(themeFrom(theme)) })
					: content,
			),
		confirm: async (title, message) => await ui.confirm(title, message),
		select: async (title, options) =>
			await ui.select(
				title,
				options.map((label) => ({ label })),
			),
		editor: async (title, prefill) => await ui.editor(title, prefill),
	};
}

/**
 * Adapt OMP's context onto the manager's host seam. `mode`/`hasUI` guard the
 * terminal-only surface; `custom` lives on `ctx.ui`, not on `ctx`, and is
 * bound so the overlay call keeps its receiver.
 *
 * Exported for the suite: this adapter is the one place the manager's shape
 * and OMP's shape have to agree, and a test cannot reach it through the
 * registered handler (the socket path is resolved at module load).
 */
export function managerHostFrom(ctx: ExtensionContext): ManagerHostContext {
	return {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		custom: ctx.ui.custom.bind(ctx.ui) as ManagerHostContext["custom"],
	};
}

/**
 * Say so when the daemon is running older code than this plugin.
 *
 * The daemon outlives the session that started it — an operator's ran for four
 * days across a plugin upgrade — so a fix shipped in the plugin tree can be
 * absent from the process actually answering. Never restarts on its own: a
 * restart kills live workers, and that is the operator's call.
 */
async function warnOnVersionDrift(
	client: DaemonClient,
	io: ExtensionIO,
): Promise<void> {
	try {
		const status = await client.call<StatusResult>("status", {});
		// A daemon older than the field itself reports nothing, which is
		// exactly the case worth surviving quietly rather than guessing about.
		if (status.version === undefined || status.version === PACKAGE_VERSION) {
			return;
		}
		io.notify(
			`oh-my-agent daemon is running ${status.version} while this plugin is ${PACKAGE_VERSION}; restart it with \`/cli daemon restart\`.`,
		);
	} catch {
		// A daemon that cannot be reached is already reported by the widget.
	}
}

const ohMyAgentExtension = (pi: ExtensionAPI): void => {
	// The socket path is fixed by the daemon's composition root; resolving it
	// at load is safe because it is pure path math, not a runtime action.
	const socketPath = join(getAgentDir(), "oh-my-agent", "daemon.sock");
	const client = createDaemonClient(socketPath);

	pi.registerCommand("cli", {
		description:
			"Run an omp-agent CLI verb without PATH: /cli status, /cli console.",
		handler: async (args, ctx) => {
			await cliCommand(ioFrom(ctx.ui), args);
		},
	});

	pi.registerCommand("console", {
		description: "Open web UI or copy console URL.",
		handler: async (_args, ctx) => {
			const io = ioFrom(ctx.ui);
			if (!ctx.hasUI) {
				io.notify(
					"Web console menu needs the TUI; run /cli console to print the URL.",
				);
				return;
			}
			await consoleCommand(io);
		},
	});

	pi.registerCommand("spawn", {
		description: "Spawn an oh-my-agent peer from its definition.",
		handler: async (args, ctx) => {
			await spawnCommand(client, ioFrom(ctx.ui), args);
			await refreshWidget(client, ioFrom(ctx.ui));
		},
	});

	pi.registerCommand("preset", {
		description:
			"Create a peer from a shipped role preset (lists them when run bare).",
		handler: async (args, ctx) => {
			await presetCommand(client, ioFrom(ctx.ui), args);
		},
	});

	pi.registerCommand("kill", {
		description: "Kill an oh-my-agent worker (asks for confirmation).",
		handler: async (args, ctx) => {
			await killCommand(client, ioFrom(ctx.ui), args);
			await refreshWidget(client, ioFrom(ctx.ui));
		},
	});

	pi.registerCommand("rooms", {
		description:
			"Rooms: read, post as @you, create a channel, or join/leave a peer.",
		handler: async (args, ctx) => {
			const io = ioFrom(ctx.ui);
			// Split off the two leading tokens and keep the rest of the line
			// exactly as typed: re-joining a `\s+` split collapses indentation
			// and runs of spaces, which silently reformats the operator's post.
			const match = /^\s*(\S+)(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(args);
			const verb = match?.[1];
			const room = match?.[2];
			const body = match?.[3] ?? "";
			if (verb === "read" && room !== undefined) {
				await roomsReadCommand(client, io, room);
				// The transcript is on screen now, so the widget's unread count
				// is answered — nothing else in the TUI shows message bodies.
				markRoomsRead(client);
			} else if (verb === "post" && room !== undefined) {
				await roomsPostCommand(client, io, room, body);
			} else if (verb === "create" && room !== undefined) {
				await roomsCreateCommand(client, io, room);
			} else if ((verb === "join" || verb === "leave") && room !== undefined) {
				await roomsMembershipCommand(client, io, verb, room, body);
			} else {
				io.notify(
					"usage: /rooms read <room> | /rooms post <room> <message> | /rooms create <room> | /rooms join <room> <agent> | /rooms leave <room> <agent>",
				);
			}
			await refreshWidget(client, io);
		},
	});

	pi.registerCommand("schedule", {
		description: "List schedules, or arm one with /schedule <id> on|off.",
		handler: async (args, ctx) => {
			const io = ioFrom(ctx.ui);
			if (args.trim().length === 0) {
				await scheduleListCommand(client, io, args);
			} else {
				await scheduleArmCommand(client, io, args);
			}
			// Arming a schedule changes what the daemon will do next; every
			// other mutating command repaints, and this one skipping it left a
			// stale widget behind the operator's own action.
			await refreshWidget(client, io);
		},
	});

	pi.registerCommand("logs", {
		description: "Show a worker's buffered output: /logs <name> [line-count].",
		handler: async (args, ctx) => {
			await logsCommand(client, ioFrom(ctx.ui), args);
		},
	});

	pi.registerCommand("inject", {
		description:
			"Push an instruction into a peer's next turn: /inject <name> <message>.",
		handler: async (args, ctx) => {
			await injectCommand(client, ioFrom(ctx.ui), args);
		},
	});
	// The manager owns no state: it opens over the transcript, drives the
	// daemon through the same socket every command uses, and closes clean.
	// `custom` lives on `ctx.ui` while the mode guard lives on `ctx`, so the
	// two are adapted onto one host object here — bound, because `custom` is
	// a method and would lose its receiver otherwise.
	pi.registerCommand("manage", {
		description: "Open the full-screen agent manager (needs the TUI).",
		handler: async (_args, ctx) => {
			await openManager(client, ioFrom(ctx.ui), managerHostFrom(ctx));
			await refreshWidget(client, ioFrom(ctx.ui));
		},
	});

	// No keybindings. Every surface is reached through a slash command, so
	// nothing here can collide with a binding the operator or another
	// extension owns, and the widget's hint names the command instead.

	// The widget is a runtime surface: first paint on session start, then a
	// refresh after every turn so counts track the daemon without polling.
	// Auto-start lives here, not at load, because OMP's runtime is not
	// initialized until session start. Spawn uses the plugin-local main.ts
	// so PATH is never required.
	pi.on("session_start", async (_event, ctx) => {
		const io = ioFrom(ctx.ui);
		try {
			const ensured = await ensureDaemon(client);
			// The launcher's own words, not the generic daemon-down sentence:
			// "already running for this profile" and "bun: command not found"
			// send the operator to entirely different places.
			if (ensured.state === "failed" && ensured.reason !== undefined) {
				io.notify(`oh-my-agent daemon did not start: ${ensured.reason}`);
			}
		} catch (error) {
			// Probe/spawn surprises must not throw into the TUI; an auth fault
			// travels out of `ensureDaemon` deliberately, and it is worth saying
			// out loud because the widget line alone reads like a dead daemon.
			io.notify(error instanceof Error ? error.message : String(error));
		}
		await warnOnVersionDrift(client, io);
		await refreshWidget(client, io);
	});
	pi.on("turn_end", async (_event, ctx) => {
		await refreshWidget(client, ioFrom(ctx.ui));
	});
};

export default ohMyAgentExtension;
