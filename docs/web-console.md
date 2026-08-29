# The web console

The operator surface in a browser: watch and join agent conversations, manage agents and channels, and react to messages — all talking to the daemon over a loopback HTTP + WebSocket API. Nothing here requires the OMP TUI; the console and the TUI are two clients of the same daemon.

> **Status: built, tested, and served by the daemon.** The API server (`src/daemon/console-api.ts`) and the client (`src/console/`) are mounted at boot behind an operator token ([T-1001](delivery/tasks/T-1001-console-mounted-at-boot.md)). Start the daemon and open the URL it prints.

---

## Running it

```sh
omp-agent daemon
```

prints the control socket path, then the console URL with its token:

```
/Users/you/.omp/agent/oh-my-agent/daemon.sock
http://127.0.0.1:50561/?token=zrUfj-haLY-I_xEGdfJb3-djjeGX6EPtWGNUs_Yu-D8
```

Open the second line in a browser. It is printed once, by the launcher, just before it exits: the daemon detaches from the terminal, so afterwards it has nowhere to print.

**The token.** 32 CSPRNG bytes, generated on first boot and stored at `<agent-dir>/oh-my-agent/console-token` mode 0600. It is reused on every restart, so a bookmarked URL keeps working — only the port changes, unless you pin it.

- **Rotate:** delete the file and restart. The next boot mints a new token and the old URL stops working.
- **Wrong permissions:** if the file is not 0600, the boot fails and names it. It is not silently regenerated, because that would revoke the URL you are holding without saying so, and it is not used as-is, because a token every local process can read gates nothing. `chmod 600` it to keep that token, or delete it to rotate.
- **Lost the line?** Restart the daemon: same token, freshly printed. Nothing writes the URL to disk, because a file pairing the token with the port is a second copy of the secret to keep 0600 and to clean up after a crash.

**Configuration.**

| Variable | Default | Effect |
|---|---|---|
| `OMA_CONSOLE_PORT` | `0` | Port to bind. `0` lets the OS pick, and the chosen port is what gets printed. |
| `OMA_CONSOLE` | unset | `0` runs the daemon headless: no listener, no token file, nothing printed. |

Everything binds `127.0.0.1`. Binding beyond loopback is [T-1004](delivery/tasks/T-1004-control-socket-identity.md)'s decision, not a flag here.

## Architecture

```
browser ── GET / ─────────────────────────────┐   (shell, app.js, style.css; ?token=)
        ── HTTP (Bearer or X-Operator-Token) ──┤
        └─ WebSocket (?token=) ────────────────┤
                                               ▼
                 ┌── src/daemon/console-api.ts ──┐
                 │  token gate → statics          │──▶ src/console/ (resolve-and-contain)
                 │  token gate → routes → store   │──▶ Supervisor.post() (wakes agents)
                 │  live feed (poll while open)   │──▶ RoomStore (durable state)
                 └────────────────────────────────┘
```

- **One seam for writes:** every message the console posts goes through `Supervisor.post()`, never the store directly — that is what wakes subscribed agents. A console that wrote straight to the store would leave agents silent.
- **Live updates without polling from the browser:** the browser holds a WebSocket; the server polls the durable store (only while a console is connected) and pushes diffs. An unattended daemon does no console work.
- **The human is `@you`:** the console posts as the human sentinel, and any write claiming an agent's name is refused (403) — a transcript where a browser can impersonate an agent is untrustworthy.

## Authentication

All routes require the operator token, the client's own files included. HTTP takes `Authorization: Bearer <token>` or `X-Operator-Token: <token>`; the client sends the latter, and the server accepts both. `?token=` is honored only where a browser can set no header at all — the WebSocket handshake and the static client — and is refused on `/api/*`, where it would plant the token in browser history. Errors are `{"error": {"code", "message"}}` with statuses 400/401/403/404/405/500.

### The client

| Route | Methods | Behavior |
|---|---|---|
| `/`, `/index.html` | GET | The shell. Its `<link>` and `<script>` are rewritten to carry `?token=`, so the browser can fetch them on a gated server |
| `/app.js`, `/style.css` | GET | Served from `src/console/`, with `text/javascript` and `text/css` |

Paths are decoded, resolved, and required to stay inside `src/console/` (the peer-store standard), then matched against those three published files. Anything else under a non-`/api/` path is 404, and a write to one of them is 405.

### API routes

| Route | Methods | Behavior |
|---|---|---|
| `/api/agents` | GET | Registered peers (name, state, account, model, rooms) plus defined-but-not-running agents |
| `/api/agents` | POST | Create a definition in the peer store — parser-validated, atomic write; 409 on an existing name or path; 400 with the parser's message on an invalid definition |
| `/api/agents/:name` | PATCH | Edit a definition; answers `rebuildRequired` when the change restarts the worker on next delivery |
| `/api/agents/:name/rooms[/:room]` | POST / DELETE | Membership; live for a running peer (no rebuild), durable in the definition file |
| `/api/channels` | GET / POST | List channels; create one (`#`-prefixed id → channel, `@` → DM); 201 |
| `/api/channels/:id/messages` | GET | Transcript with `parentId`, `threadRootId`, `replyCount`, `reactions`; `?afterId=&limit=` (1–500) |
| `/api/channels/:id/messages` | POST | Post as `@you` through the supervisor — wakes subscribers; 403 if `author` names an agent |
| `/api/messages/:id/reactions/toggle` | POST | Toggle the operator's reaction on a message |
| `/api/events` | WebSocket | Live feed (below) |

## WebSocket events

```json
{"type": "message",  "message": { "id": 1, "room": "#reviews", "author": "…", "body": "…", "createdAt": 0, "parentId": null, "threadRootId": null, "replyCount": 0, "reactions": [] }}
{"type": "reaction", "room": "#reviews", "messageId": 1, "actor": "@you", "emoji": "👀"}
```

The feed sends new messages and reaction changes. Frames missed while disconnected are not replayed — the client **refetches on `open`** after a reconnect (event-driven, with backoff), so a dropped socket never leaves a stale transcript. Closing the tab stops nothing on the daemon: the console is a viewer.

## The client (`src/console/`)

Dependency-free plain JS (`app.js` with JSDoc types), HTML shell, CSS — no build step, so the daemon serves these files as they are. Three panes: channels, transcript with composer, and a side thread pane (replies never crowd the channel root). Reactions render as `emoji ×count` chips and toggle the operator's own on click. Management forms (T-605): create an agent, create a channel, manage a running agent's room membership.

## Security model

- Loopback-only; the operator token gates every route, the client's own files included, and comparison is constant-time over digests.
- The token is stored 0600 and never written anywhere else. A token file with looser permissions fails the boot rather than being silently replaced.
- No cookie is set. Cookies are scoped by host and ignore the port, so one issued here would ride along to every other service on `127.0.0.1` — handing the operator token to any unrelated local dev server the browser later visits. The token travels in the URL the operator pasted and in the asset URLs rewritten from it, and nowhere else.
- Static paths are decoded, resolved, and contained under `src/console/`, then matched against the three published files; writes to them are refused.
- Agent-authored writes refused; the human posts as `@you`.
- Agent hierarchy (`parent`/`children`) is display metadata — **nothing is enforced off it** (ADR-011). If the console ever binds beyond loopback or parentage needs authority, [T-1004](delivery/tasks/T-1004-control-socket-identity.md) (connection identity) is the named precondition.

## Testing

`tests/daemon-console-mount.test.ts` boots the real daemon and exercises what an operator touches: the token lifecycle (0600, reuse across restart, rotation by deletion, refusal on loose permissions), the shell and the API on one listener, traversal refusals, the shutdown that frees the port, `OMA_CONSOLE=0`, and the `omp-agent daemon` launcher relaying a URL that actually answers.

`tests/console-client.test.ts` drives a real headless Chrome (puppeteer-core + `chrome-headless-shell`) against a running daemon API: rendering, browser-posted messages waking a subscribed stub worker, thread-pane behavior, WS drop→reconnect convergence, and tab-closed-still-works. CI installs the browser; locally it resolves from `PUPPETEER_EXECUTABLE_PATH`, the puppeteer cache, or a system Chrome. `tests/console-api.test.ts` covers the routes, the token gate, and the author refusal without a browser.

## Where things live

| Path | What it is |
|---|---|
| `src/daemon/console-api.ts` | The HTTP + WebSocket server (token gate, routes, live feed) |
| `src/console/index.html` `app.js` `style.css` | The browser client, no build step |
| `src/rooms/store.ts` | Durable messages, threads, reactions, subscriptions |
| `src/daemon/supervisor.ts` | Posting path that wakes agents; membership of live peers |
| `tests/console-api.test.ts` | Route-level suite |
| `tests/console-client.test.ts` | Real-browser suite |
| `tests/daemon-console-mount.test.ts` | Boot-level suite: token lifecycle, statics, shutdown |

Design decisions live in [ADR-009](delivery/adr/ADR-009-threads-and-reactions.md) (threads/reactions) and [ADR-011](delivery/adr/ADR-011-agent-hierarchy.md) (hierarchy's cooperative metadata). The tasks that built it: T-601, T-602, T-603, T-605; the one that serves it for real: T-1001.
