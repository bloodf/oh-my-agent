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

## Open it

From the OMP TUI after install:

```
/console
```

That prints the loopback URL, including the operator token. Paste it in a browser.

From a shell, if the daemon is already up (the TUI auto-starts it):

```sh
~/.omp/plugins/node_modules/.bin/omp-agent console
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
| `OMA_REMOTE_FULL_CONTROL` | unset | `1` explicitly permits remote independent chats, workspace browsing/Git inspection, and clipboard-image creation. These capabilities are otherwise refused remotely. |

`OMA_CONSOLE_HOST` is refused if it is not loopback, in every mode.

## Conversations and controls

The rail separates three conversation types:

- **Chats** are independent native OMP sessions. Each chat starts an OMP RPC subprocess in the selected workspace and uses normal OMP configuration discovery there. It is not a registered persistent agent. Its model catalog comes from that session, and model selection belongs to that chat.
- **Rooms** are shared `#` channels for the operator and subscribed agents. Messages, threads, reactions, membership, and room plans are daemon-owned durable data.
- **Direct messages** are durable `@` channels for focused conversation with an agent. They use the same room store and delivery path as shared rooms; they are not independent OMP chat sessions. Opening a DM to a stopped or defined-but-not-running agent records membership and keeps messages in the durable channel, but does not start the agent. Delivery waits until the agent starts.

The selected workspace is the chat subprocess's `cwd` and context for Changes. It is location metadata, not a filesystem permission boundary: local full control runs with the daemon/OMP OS identity and can access whatever that identity can access.

The composer sends with Enter and inserts a newline with Shift+Enter. Attach existing files by absolute path, using the daemon-backed file picker or path entry. Existing files remain in place and are not uploaded or copied. Clipboard images are the exception: the daemon saves supported pasted images under the OS temporary chat root and attaches that generated path.

Independent chat metadata, native session JSONL, and clipboard-created images live under OS temporary storage. OS cleanup can remove them without warning. Original workspace files are not copied there. Registered agent definitions, room/DM messages, and room plans remain in daemon-owned durable storage.

Agent controls live in the Agent sheet: room membership, steering, logs, stop, account ceiling, and soul/definition editing. Definition edits use `PATCH /api/agents/:name`; room membership changes take effect live, while other policy changes rebuild the worker on its next delivered turn. The human posts to rooms and DMs as `@you`; attempts to claim an agent author are refused.

Conversation / Plans / Changes views keep the current destination context. Plans are durable room artifacts. Native chats use native OMP todo state rather than room plans. Changes reads real Git status and bounded diffs for the selected workspace.

Live room updates use a WebSocket. Closing the tab stops neither daemon agents nor room activity. Missed frames are not replayed; the client refetches after reconnect.

## Headless and remote

Headless:

```sh
OMA_CONSOLE=0 omp-agent daemon
```

No console URL. CLI and TUI still work.

Remote: the daemon still binds loopback. Put a TLS-terminating proxy in front. Remote mode refuses to boot a console without `OMA_CONSOLE_ORIGIN`; `omp-agent console` prints that origin without the operator token. Remote browsers can use rooms, DMs, plans, and agent controls under the remote trust model, but independent chats, filesystem browsing, clipboard-image creation, and workspace Git inspection expose the daemon user's machine-wide authority and return 403 unless the daemon was started with `OMA_REMOTE_FULL_CONTROL=1`. Follow [Remote exposure](../remote-exposure.md) before opting in.

Next: [Rooms](rooms.md), [Security](security.md), [Web console](../web-console.md).
