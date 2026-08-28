/**
 * Purpose: The OMP extension entry point (§4.5) — registers the operator
 * commands and wires the status widget. Load-time work is registration only:
 * OMP's runtime actions throw `ExtensionRuntimeNotInitializedError` before
 * session start, so every socket call lives inside a handler.
 *
 * Public API: the default-exported `ExtensionFactory`.
 *
 * Upstream deps: `./commands` (command logic), `./widget` (client +
 * refresh). Both are socket-only; nothing here touches daemon state or the
 * database directly (§4.5).
 *
 * Downstream consumers: OMP's extension loader (`omp.extensions` in
 * package.json).
 *
 * Failure modes: command handlers render errors as notices through the
 * `ExtensionIO` adapter; nothing throws into the TUI. The widget refreshes
 * on session start and after every turn, so a daemon that comes up late is
 * picked up without a reload.
 */

import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
/** `getAgentDir()` from pi-utils resolves the active profile's agent dir. */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { ExtensionIO } from "./commands";
import {
	agentsCommand,
	injectCommand,
	killCommand,
	logsCommand,
	roomsPostCommand,
	roomsReadCommand,
	scheduleArmCommand,
	scheduleListCommand,
	spawnCommand,
} from "./commands";
import type { ManagerHostContext } from "./manager";
import { openManager } from "./manager";
import { createDaemonClient, refreshWidget } from "./widget";

/** Adapt OMP's UI context onto the seam the commands are written against. */
function ioFrom(ui: ExtensionUIContext): ExtensionIO {
	return {
		notify: (message) => ui.notify(message),
		setWidget: (key, lines) => ui.setWidget(key, lines),
		confirm: async (title, message) => await ui.confirm(title, message),
		select: async (title, options) =>
			await ui.select(
				title,
				options.map((label) => ({ label })),
			),
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

const ohMyAgentExtension = (pi: ExtensionAPI): void => {
	// The socket path is fixed by the daemon's composition root; resolving it
	// at load is safe because it is pure path math, not a runtime action.
	const socketPath = join(getAgentDir(), "oh-my-agent", "daemon.sock");
	const client = createDaemonClient(socketPath);

	pi.registerCommand("agents", {
		description: "List oh-my-agent peers with live state from the daemon.",
		handler: async (args, ctx) => {
			await agentsCommand(client, ioFrom(ctx.ui), args);
		},
	});

	pi.registerCommand("spawn", {
		description: "Spawn an oh-my-agent peer from its definition.",
		handler: async (args, ctx) => {
			await spawnCommand(client, ioFrom(ctx.ui), args);
			await refreshWidget(client, ioFrom(ctx.ui));
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
		description: "Read a room transcript or post into it as @you.",
		handler: async (args, ctx) => {
			const io = ioFrom(ctx.ui);
			const [verb, room, ...rest] = args.trim().split(/\s+/);
			if (verb === "read" && room !== undefined) {
				await roomsReadCommand(client, io, room);
			} else if (verb === "post" && room !== undefined) {
				await roomsPostCommand(client, io, room, rest.join(" "));
			} else {
				io.notify("usage: /rooms read <room> | /rooms post <room> <message>");
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
		},
	});

	// Feature-guarded: `registerShortcut` is present on the real
	// `ExtensionAPI`, but a host (or an older one) that lacks it must still
	// load the extension — the shortcut is a convenience, and `/manage` is
	// the surface that has to work.
	pi.registerShortcut?.("ctrl+g", {
		description: "Open the oh-my-agent manager.",
		handler: async (ctx) => {
			await openManager(client, ioFrom(ctx.ui), managerHostFrom(ctx));
		},
	});

	// The widget is a runtime surface: first paint on session start, then a
	// refresh after every turn so counts track the daemon without polling.
	pi.on("session_start", async (_event, ctx) => {
		await refreshWidget(client, ioFrom(ctx.ui));
	});
	pi.on("turn_end", async (_event, ctx) => {
		await refreshWidget(client, ioFrom(ctx.ui));
	});
};

export default ohMyAgentExtension;
