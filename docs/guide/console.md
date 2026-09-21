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

`console:dev` starts Vite for UI development on `http://localhost:5173`, proxying `/api` and the live WebSocket to the running daemon (`OMA_CONSOLE_URL`, else the daemon's `console-url` file, else `http://127.0.0.1:50561`). Open it with `?token=<operator-token>`. `console:build` replaces the three production assets above.

## See every screen (no daemon)

```sh
bun run storybook
```

Open `http://127.0.0.1:6006/catalog.html`. The catalog renders real console components and states with isolated demo data; it does not connect to a daemon.

## Appearance

Use **Appearance** in the global toolbar to pick a sidebar theme: **Aubergine** (the default), **Ochin**, **Hoth**, **Monument**, **Work Hard**, or **Nocturne**. Select **Light**, **Dark**, or **System** for the message canvas; the choice is saved in this browser and does not change agent configuration or discard conversation drafts. System mode follows the device appearance.

A theme colors the rail, toolbar, and sidebar and keeps that identity in both modes, as Slack does, while conversation surfaces switch between light and dark. Theme data is bundled: changing themes makes no external requests. A theme chosen from the earlier 59-palette catalog falls back to Aubergine and keeps its mode.

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

The first load sets a static cookie so a reload works after the client strips `?token=` from the address bar. It holds an HMAC of the token, not the token, and it only opens the console's own static files; the API and the WebSocket never accept it. A cookie on `127.0.0.1` rides along to every other local service on that host, which is why it is worth nothing beyond the public bundle. If the token is rotated, an open tab shows the token prompt instead of retrying.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `OMA_CONSOLE_PORT` | `0` (OS-assigned) | Port to bind. Must be a decimal 0–65535 if set. |
| `OMA_CONSOLE` | unset (enabled) | `0` runs headless: no listener or console URL. The daemon still loads or mints the operator token for a later console-enabled boot. |
| `OMA_REMOTE` | unset | Enables the remote proxy trust model. See [Remote exposure](../remote-exposure.md). |
| `OMA_CONSOLE_ORIGIN` | unset | Required when `OMA_REMOTE=1` and the console is enabled. Exact external HTTPS origin, no credentials, path, query, or hash. |
| `OMA_REMOTE_FULL_CONTROL` | unset | `1` explicitly permits remote independent chats, workspace changes, agent Start, agent creation, agent policy edits, filesystem/Git inspection, and temporary uploads. These capabilities are otherwise refused remotely. |

`OMA_CONSOLE_HOST` is refused if it is not loopback, in every mode.

## Conversations and controls

The rail separates three conversation types:

- **Chats** are independent native OMP sessions. Each chat starts an OMP RPC subprocess in the selected workspace and uses normal OMP configuration discovery there. It is not a registered persistent agent. Its model catalog comes from that session, and model selection belongs to that chat.
- **Rooms** are shared `#` channels for the operator and subscribed agents. Messages, threads, reactions, membership, and room plans are daemon-owned durable data.
- **Direct messages** are durable `@` channels for focused conversation with an agent. They use the same room store and delivery path as shared rooms; they are not independent OMP chat sessions. Opening a DM to a stopped or defined-but-not-running agent records membership and keeps messages in the durable channel, but does not start the agent. Delivery waits until the agent starts.

Choose a working directory for each channel, agent/bot, or independent OMP chat. Channel directories persist across restarts. On explicit Start, an agent's own workspace takes precedence; otherwise it inherits the sole configured workspace among its channels. Conflicting channel workspaces require an explicit agent workspace. Running workers keep their working directory until restart; explicit definition changes apply through the existing rebuild policy. Workspace is location metadata, not a filesystem permission boundary.

The composer sends with Enter and inserts a newline with Shift+Enter. **Reference local files** uses the daemon picker or absolute-path entry: originals remain in place and are never uploaded, copied, or deleted. **Upload files** accepts browser-selected, dropped, or pasted files of any type into private OS temporary storage. Each file may be up to 25 MiB; at most 4 upload at once and 40 are kept until removed or expired. Browser and proxy limits still apply. Progress and Cancel stay visible; cancellation preserves the message draft and removes partial uploads.

Temporary uploads expire after 24 hours; cleanup runs on daemon startup and hourly. Removing an unsent upload deletes only its managed copy. Sending retains it until expiry, so a durable room message may eventually reference an expired file. Keep permanent source files as local path references instead. Independent chat metadata and native session JSONL also live in OS temporary storage and can disappear under OS cleanup. Agent definitions, room/DM history, membership, and plans remain durable.

**Create agent** makes a durable native OMP peer. **Create automated bot** uses the same peer lifecycle with message wake rules, a turn bound, and optional cron instruction; it is not a separate launcher. Both dialogs can set a model and an avatar at creation. Set a usable model before Start. The Agent sheet provides membership, explicit Start, steering, logs, Stop, schedules, and **Settings** for each agent. Settings is a sectioned dialog that edits the whole definition: **Soul** (the Markdown body, with a preview), **Profile** (description, display name, avatar), **Model** (model from the daemon's catalog, fallbacks, thinking level, tools), **Rooms & hierarchy** (channels, spawn permissions, working directory when full control is on), **Wake & autonomy** (wake rules, heartbeat, maximum turns), **Schedules & automations**, **Sandbox & tools** (sandbox, extra roots, MCP servers, skills), and **Advanced JSON** for any other field. Saving sends only the fields that changed through `PATCH /api/agents/:name`; membership takes effect live, while other policy changes rebuild on the next delivered turn. Stopped-agent DMs wait for explicit Start.

The console does not manage spending. Agents run through OMP's own sign-in, so a subscription or an API key is controlled where you configured it; the account ceiling controls are gone from the Agent sheet and the create dialogs. A definition that already declares `autonomy.budgetUsd` shows it read-only in **Wake & autonomy**, and saving keeps it. `omp-agent bump` still raises a metered ceiling from the CLI.

Avatars default to a [blobatar](https://github.com/Alain00/blobatar) generated from the wire name. Set an emoji, up to four characters, or an image in **Profile and avatars** on the toolbar, in an agent's **Settings → Profile**, or by clicking an agent's avatar in the Members tab. An uploaded PNG, JPEG, WebP, or GIF is resized in the browser to fit 256×256 and re-encoded before it is saved; the daemon refuses any image over 200 KB and any other file type. While an agent holds ⏳ on a message, its default blobatar takes the thinking pose.

Conversation / Plans / Changes views keep the current destination context. Plans are durable room artifacts. Native chats use native OMP todo state rather than room plans. Changes reads real Git status and bounded diffs for the selected workspace.

Live room updates use a WebSocket. Closing the tab stops neither daemon agents nor room activity. Missed frames are not replayed; the client refetches after reconnect.

## Headless and remote

Headless:

```sh
OMA_CONSOLE=0 omp-agent daemon
```

No console URL. CLI and TUI still work.

Remote: the daemon still binds loopback. Put a TLS-terminating proxy in front. Remote mode refuses to boot a console without `OMA_CONSOLE_ORIGIN`; `omp-agent console` prints that origin without the operator token. Basic rooms, DMs, and plans remain available under the remote trust model. Starting agents, creating agents, changing workspaces, independent OMP chats, filesystem browsing, uploads, and Git inspection require `OMA_REMOTE_FULL_CONTROL=1`. Without it, remote Settings saves may change only an agent's description, model, thinking level, and rooms; saving the body, tools, sandbox, MCP servers, skills, spawn permissions, wake, heartbeat, autonomy, schedules, automations, or any other field is refused. Follow [Remote exposure](../remote-exposure.md) before opting in.

Next: [Rooms](rooms.md), [Security](security.md), [Web console](../web-console.md).
