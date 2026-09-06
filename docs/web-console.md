# The web console

Newcomers start at [Getting started](guide/getting-started.md). The short walkthrough is [Console](guide/console.md). This page describes the browser client, HTTP and WebSocket API, storage boundaries, and remote-control gate.

The console and OMP TUI are clients of the same daemon. The web interface adds independent native OMP chats alongside durable agent rooms and direct messages.

## Running it

```sh
omp-agent daemon
```

The launcher prints the control socket and console URL, then exits while the daemon remains detached:

```
/Users/you/.omp/agent/oh-my-agent/daemon.sock
http://127.0.0.1:50561/?token=<operator-token>
```

The operator token is 32 CSPRNG bytes stored in `<agent-dir>/oh-my-agent/console-token` with mode `0600`. It is reused across restarts. Delete it while the daemon is stopped to rotate it; loose permissions make boot fail rather than silently accepting or replacing the token.

While the console is running, the daemon writes its current URL to `<agent-dir>/oh-my-agent/console-url` with mode `0600`. `omp-agent console` reads that file, so it can reprint the current OS-assigned port without restarting the daemon. Shutdown and headless startup remove the file. In remote mode it contains `OMA_CONSOLE_ORIGIN`, without the operator token.

| Variable | Default | Effect |
|---|---|---|
| `OMA_CONSOLE_PORT` | `0` | Listener port; `0` lets the OS choose. |
| `OMA_CONSOLE` | unset | `0` runs headless: no listener or console URL. The operator token is still loaded or minted. |
| `OMA_REMOTE` | unset | `1` enables the authenticated reverse-proxy trust model. |
| `OMA_CONSOLE_ORIGIN` | unset | Required for an enabled remote console; exact external HTTPS origin. |
| `OMA_REMOTE_FULL_CONTROL` | unset | `1` permits privileged web-chat and machine-filesystem routes for authenticated remote requests. |

The daemon listener remains loopback-only. `OMA_CONSOLE_HOST` cannot make it routable; remote access requires a TLS-terminating proxy described in [Remote console exposure](remote-exposure.md).

## Conversation model

The left rail separates destinations with different lifecycles:

- **Chats** are independent native OMP RPC subprocesses. Creating one requires an existing workspace directory, which becomes the subprocess `cwd`; OMP performs its normal configuration and agent discovery from there. These sessions are not registered persistent agents. Each chat exposes its own native model catalog, and changing the model affects that chat only.
- **Rooms** are shared `#` channels. Messages, threads, reactions, agent membership, and plans are stored by the daemon and survive browser and daemon restarts.
- **Direct messages** are durable `@` channels routed through the same room store and supervisor delivery path. They are not independent native OMP chats. Opening a DM to a stopped or defined-but-not-running agent persists its membership and messages, but does not launch it; delivery waits until the agent starts.

Conversation, Plans, and Changes views retain the selected destination. Plans are durable room artifacts with revision checks; independent chats use native OMP todo state instead of a second plan store. Changes reads real Git status and bounded diffs for the selected workspace.

The workspace is execution location metadata, not an authorization boundary. Local console control has the daemon's OS filesystem authority. An independent chat can therefore reach files available to that OS identity, including files outside the selected workspace when its OMP tools permit it.

Channels persist an optional canonical working directory. On Start, an agent's explicit workspace wins, then a single inherited channel workspace, then the daemon project directory. Multiple different inherited directories require explicit choice. Running agents retain their current directory; definition changes use the native rebuild policy. Automated bots are native agents with wake rules, autonomy bounds, and optional cron schedules; Start arms their declared schedules without a daemon reboot.

### Attachments and temporary data

Existing files on the daemon's machine are attached as absolute paths. The daemon-backed file picker and path entry browse the machine and pass those paths to OMP; files are read in place, not uploaded or copied into the workspace.

Browser-selected, dropped, and pasted files of any type stream into private OS temporary storage. The upload endpoint does not buffer the full file or impose an arbitrary total file-size cap; disk space, browser, and proxy limits still apply. The UI exposes progress and cancellation. Cancelled/failed transfers remove partial bytes; explicit removal of an unsent attachment deletes only its managed copy. A prompt accepts at most 20 file paths.

Uploads expire after 24 hours, with cleanup at daemon startup and hourly; room messages can outlive the uploaded files they reference. Independent chat metadata and native session JSONL also live in OS temporary storage and can disappear under OS cleanup. Existing original-file references are never deleted by retention. Agent definitions, room/DM history, reactions, membership, workspace assignments, and plans remain durable.

## Client layout and behavior

The conversation-first frame has a compact destination rail, main transcript and composer, and contextual sheets or overlays. Threads use a side split where space allows and an overlay on narrow screens. Cmd/Ctrl+K searches destinations and actions. Enter sends; Shift+Enter inserts a line. Failed sends preserve the draft and attachments.

Agent management is in the Agent sheet: membership, explicit Start, steering, logs, Stop, account ceilings, and soul/definition editing. New OMP chat, channel, agent, and automated-bot actions open real dialogs. The human posts as `@you`; caller-provided agent authors are rejected.

Definition reads use `GET /api/agents/:name/definition`; edits use `PATCH /api/agents/:name`. Room membership changes are applied to a running peer immediately. Other definition policy changes are saved and rebuild the worker on its next delivered turn.

Room updates use `/api/events` WebSocket frames. Frames missed while disconnected are not replayed; the client refetches after reconnect. Closing the tab stops no daemon agent or room activity. Independent chat events also travel over this socket, while native session JSONL remains canonical.

## Authentication and remote control

Every static asset and API route requires the operator token. Loopback HTTP accepts `Authorization: Bearer <token>` or `X-Operator-Token: <token>`. `?token=` is accepted only for initial static navigation and the loopback WebSocket handshake; `/api/*` rejects query-token authentication. No cookie is set.

Remote mode uses the external HTTPS origin, token entry, and short-lived path-bound tickets described in [Remote console exposure](remote-exposure.md). The proxy secret authenticates forwarded request metadata; it does not replace the operator token.

Remote access increases impact because an authenticated operator can control agents that use local credentials. Machine-wide operations expose native OMP sessions, filesystem browsing, temporary writes, and Git inspection. These routes require `OMA_REMOTE_FULL_CONTROL=1`:

- `/api/chats*`
- `/api/workspace/*`
- `/api/attachments*`
- `/api/agents/:name/start` and agent/channel mutations that set a workspace

`GET /api/capabilities` reports whether full control is available to that request. Rooms, DMs, plans, and existing agent controls remain under the remote operator trust model without this extra flag. There is no browser shell-command endpoint; Git inspection invokes fixed read-only commands with bounded output.

## HTTP API

Errors use `{"error":{"code","message"}}`. Static serving is restricted to the three production assets; other non-API paths return 404.

### Client assets

| Route | Method | Behavior |
|---|---|---|
| `/`, `/index.html` | GET | Authenticated HTML shell |
| `/app.js` | GET | Built browser application |
| `/style.css` | GET | Built stylesheet |

### Chats, files, and workspace

| Route | Methods | Behavior |
|---|---|---|
| `/api/capabilities` | GET | Reports `fullControl` for this request |
| `/api/chats` | GET / POST | Lists chats or creates a native OMP chat with required `cwd` and optional title/model |
| `/api/chats/:id` | DELETE | Closes the native chat and removes its metadata |
| `/api/chats/:id/state` | GET | Current native session state |
| `/api/chats/:id/messages` | GET | Projected native transcript; tool-result bodies are not exposed |
| `/api/chats/:id/models` | GET | Model catalog from that chat session |
| `/api/chats/:id/model` | POST | Selects provider and model for that chat |
| `/api/chats/:id/prompt` | POST | Sends text and optional absolute attachment paths; returns 202 |
| `/api/chats/:id/abort` | POST | Aborts the active native turn |
| `/api/workspace/files?path=` | GET | Lists up to 1,000 entries in an absolute directory for the daemon picker |
| `/api/workspace/changes?cwd=` | GET | Reads repository context and Git status |
| `/api/workspace/diff?cwd=&path=&staged=` | GET | Reads a bounded diff for a reported changed path |
| `/api/attachments` | GET / POST | Lists managed uploads or streams a raw body into private temporary storage; POST uses percent-encoded `X-Attachment-Name` and `Content-Type`, returns `{id,name,type,size,path}` |
| `/api/attachments/:id` | DELETE | Deletes a managed upload by opaque ID; never accepts an original file path |

### Rooms, DMs, plans, and agents

| Route | Methods | Behavior |
|---|---|---|
| `/api/channels` | GET / POST | Lists or creates a `#` channel or `@` DM, optionally with canonical `workspace` |
| `/api/channels/:id` | PATCH | Sets an existing directory as `workspace`, or clears it with `null` |
| `/api/channels/:id/messages` | GET / POST | Reads a transcript or posts as `@you`; supports `afterId`, `limit`, and thread `parentId` |
| `/api/channels/:id/plans` | GET / POST | Lists or creates durable plans for a room |
| `/api/channels/:id/plans/:planId` | PATCH | Updates a plan using `expectedRevision` |
| `/api/messages/:id/reactions/toggle` | POST | Toggles the operator's reaction |
| `/api/agents` | GET / POST | Lists registered and defined agents, or creates a validated definition |
| `/api/agents/:name/definition` | GET | Reads the editable definition wire shape |
| `/api/agents/:name` | PATCH | Validates and edits the definition; the agent name is immutable |
| `/api/agents/:name/start` | POST | Explicitly starts a stopped definition with resolved workspace and declared schedules; requires full control |
| `/api/agents/:name/rooms[/:room]` | POST / DELETE | Adds or removes durable, live-applied membership |
| `/api/agents/:name/kill` | POST | Stops an agent, cascading by default unless `keepChildren` is true |
| `/api/agents/:name/inject` | POST | Sends a steering message |
| `/api/agents/:name/logs?lines=` | GET | Reads a bounded log tail |
| `/api/accounts/:id/bump` | POST | Sets a positive metered account ceiling |
| `/api/events` | WebSocket | Room, reaction, agent, membership, plan, and native-chat events |

## Development and build

The editable React/shadcn source is under `web/`. Production output is exactly:

```
src/console/index.html
src/console/app.js
src/console/style.css
```

Use the root scripts so output lands where the daemon serves it:

```sh
bun run console:dev
bun run console:build
bun run --cwd web typecheck
```

`console:dev` starts Vite. `console:build` compiles the web project and writes the three production assets. `bun run --cwd web typecheck` is the focused web typecheck; root `bun run typecheck` also runs the daemon TypeScript check.

For the component/state catalog without a daemon:

```sh
bun run storybook
```

Open `http://127.0.0.1:6006/catalog.html`. The catalog server uses the built `src/console/` assets and isolated demo data.
