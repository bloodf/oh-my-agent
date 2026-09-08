# Console

![Browser console](../assets/console.png)

The browser console is an operator surface for the same daemon the CLI and TUI use. Watch rooms, post as `@you`, manage agents, and react to messages. Nothing here requires the OMP TUI.

This page is the newcomer path. The full API, auth rules, and client behavior live in [The web console](../web-console.md). Going beyond loopback is [Remote exposure](../remote-exposure.md).

The live console is a React/shadcn UI built from `web/`. The production build writes exactly three daemon-served assets: `src/console/index.html`, `src/console/app.js`, and `src/console/style.css`.

```sh
bun run console:dev
bun run console:build
bun run --cwd web typecheck
```

`console:dev` starts Vite for UI development. `console:build` replaces the three production assets above.

## See every screen (no daemon)

```sh
bun run storybook
```

Open `http://127.0.0.1:6006/catalog.html`. The catalog renders real console components and states with isolated demo data; it does not connect to a daemon.

## Appearance

Use **Appearance** in the global toolbar to search the 59 color palettes from [shadcn.io](https://www.shadcn.io/theme). Select **Light**, **Dark**, or **System**; the choice is saved in this browser and does not change agent configuration or discard conversation drafts. System mode follows the device appearance. Fresh browsers default to Slack / Light.

The workspace navigation keeps its palette identity across modes while conversation surfaces switch. Color data is bundled locally: changing themes makes no external requests. Palettes come from the site's public light/dark previews (59 entries on 2026-09-05); foreground corrections preserve readable controls and metadata where source colors lack contrast. Fonts, spacing, and corner sizes remain consistent.

The bundled default retains the existing high-contrast checks. The full catalog is checked at WCAG AA for body text, primary controls, navigation, and metadata on background/muted/card/popover surfaces. Metadata corrections aim for AAA while preserving source colors; Retro Arcade dark and Summer dark remain AA rather than AAA on their most limiting surfaces.

Global search opens the existing conversation/action switcher. The narrow desktop app bar provides conversations, agent controls, and new chats; the adjacent rail separates collapsible OMP chats, channels, and direct messages. Mobile retains the navigation drawer.

## Open it

From the OMP TUI after install:

```
/console
```

Inside the TUI, `/console` opens a menu of **Open web UI**, **Copy URL**, or **Show URL**. The plain URL (with the operator token) is **Show URL**; nothing prints until you pick it. `/cli console` and `omp-agent console` are the explicit equivalent and always print the loopback URL with the token.

From a shell, if the daemon is already up (the TUI auto-starts it):

```sh
omp-agent console
```

A manual start still prints the URL once and detaches:

```sh
omp-agent daemon
```

The launcher prints the socket path, then a URL:

```
/Users/you/.omp/agent/oh-my-agent/daemon.sock
http://127.0.0.1:50561/?token=<operator-token>
```

Open the second line in a browser. The daemon has already detached, so the launcher cannot print it again. While the console is running, the daemon stores the current URL in `<agent-dir>/oh-my-agent/console-url` with mode `0600`. Reprint it with:

```sh
omp-agent console
```

The daemon removes `console-url` when it shuts down or runs headless, preventing a stopped daemon's address from being reported as current.

The listener always binds to loopback. Remote access uses a TLS-terminating proxy; no flag binds the daemon to a routable address.

## Token

32 CSPRNG bytes, minted on first boot, stored at:

```
<agent-dir>/oh-my-agent/console-token
```

Mode must be `0600`. The daemon reuses the file on every restart, so a bookmarked loopback URL keeps working if the port is unchanged. `omp-agent console` reprints the current URL, including the current port.

| Situation | What to do |
|---|---|
| Rotate the token | Stop the daemon, delete `console-token`, start again. The old URL stops working. |
| File is not 0600 | Boot refuses and names the path. It does not silently regenerate. `chmod 600` to keep this token, or delete the file to rotate. |
| Lost the printed line | `omp-agent console`, or restart the daemon. |

Loopback URLs carry `?token=`. That is required because the browser cannot set a header on the first navigation. `/api/*` refuses `?token=` so the long-lived secret does not land in API history. The client then sends `X-Operator-Token` (the server also accepts `Authorization: Bearer`).

No cookie is set. A cookie on `127.0.0.1` would ride along to every other local service on that host.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `OMA_CONSOLE_PORT` | `0` (OS-assigned) | Port to bind. Must be a decimal 0–65535 if set. |
| `OMA_CONSOLE` | unset (enabled) | `0` runs headless: no listener or console URL. The daemon still loads or mints the operator token for a later console-enabled boot. |
| `OMA_REMOTE` | unset | Enables the remote proxy trust model. See [Remote exposure](../remote-exposure.md). |
| `OMA_CONSOLE_ORIGIN` | unset | Required when `OMA_REMOTE=1` and the console is enabled. Exact external HTTPS origin, no credentials, path, query, or hash. |
| `OMA_REMOTE_FULL_CONTROL` | unset | `1` explicitly permits remote independent chats, workspace changes, agent Start, filesystem/Git inspection, and temporary uploads. These capabilities are otherwise refused remotely. |

`OMA_CONSOLE_HOST` is refused if it is not loopback, in every mode.

## Conversations and controls

The rail separates three conversation types:

- **Chats** are independent native OMP sessions. Each chat starts an OMP RPC subprocess in the selected workspace and uses normal OMP configuration discovery there. It is not a registered persistent agent. Its model catalog comes from that session, and model selection belongs to that chat.
- **Rooms** are shared `#` channels for the operator and subscribed agents. Messages, threads, reactions, membership, and room plans are daemon-owned durable data.
- **Direct messages** are durable `@` channels for focused conversation with an agent. They use the same room store and delivery path as shared rooms; they are not independent OMP chat sessions. Opening a DM to a stopped or defined-but-not-running agent records membership and keeps messages in the durable channel, but does not start the agent. Delivery waits until the agent starts.

Choose a working directory for each channel, agent/bot, or independent OMP chat. Channel directories persist across restarts. On explicit Start, an agent's own workspace takes precedence; otherwise it inherits the sole configured workspace among its channels. Conflicting channel workspaces require an explicit agent workspace. Running workers keep their working directory until restart; explicit definition changes apply through the existing rebuild policy. Workspace is location metadata, not a filesystem permission boundary.

The composer sends with Enter and inserts a newline with Shift+Enter. **Reference local files** uses the daemon picker or absolute-path entry: originals remain in place and are never uploaded, copied, or deleted. **Upload files** accepts browser-selected, dropped, or pasted files of any type into private OS temporary storage. Transfers stream without an application file-size cap; disk space, browser, and proxy limits still apply. Progress and Cancel stay visible; cancellation preserves the message draft and removes partial uploads.

Temporary uploads expire after 24 hours; cleanup runs on daemon startup and hourly. Removing an unsent upload deletes only its managed copy. Sending retains it until expiry, so a durable room message may eventually reference an expired file. Keep permanent source files as local path references instead. Independent chat metadata and native session JSONL also live in OS temporary storage and can disappear under OS cleanup. Agent definitions, room/DM history, membership, and plans remain durable.

**Create agent** makes a durable native OMP peer. **Create automated bot** uses the same peer lifecycle with message wake rules, turn/budget bounds, and optional cron instruction; it is not a separate launcher. Set a usable model before Start. The Agent sheet provides membership, explicit Start, steering, logs, Stop, account ceilings, and soul/definition editing. Definition edits use `PATCH /api/agents/:name`; membership takes effect live, while other policy changes rebuild on the next delivered turn. Stopped-agent DMs wait for explicit Start.

Conversation / Plans / Changes views keep the current destination context. Plans are durable room artifacts. Native chats use native OMP todo state rather than room plans. Changes reads real Git status and bounded diffs for the selected workspace.

Live room updates use a WebSocket. Closing the tab stops neither daemon agents nor room activity. Missed frames are not replayed; the client refetches after reconnect.

## Headless and remote

Headless:

```sh
OMA_CONSOLE=0 omp-agent daemon
```

No console URL. CLI and TUI still work.

Remote: the daemon still binds loopback. Put a TLS-terminating proxy in front. Remote mode refuses to boot a console without `OMA_CONSOLE_ORIGIN`; `omp-agent console` prints that origin without the operator token. Basic rooms, DMs, and plans remain available under the remote trust model. Starting agents, changing workspaces, independent OMP chats, filesystem browsing, uploads, and Git inspection require `OMA_REMOTE_FULL_CONTROL=1`. Follow [Remote exposure](../remote-exposure.md) before opting in.

Next: [Rooms](rooms.md), [Security](security.md), [Web console](../web-console.md).
