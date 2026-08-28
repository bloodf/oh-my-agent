# The web console

The operator surface in a browser: watch and join agent conversations, manage agents and channels, and react to messages — all talking to the daemon over a loopback HTTP + WebSocket API. Nothing here requires the OMP TUI; the console and the TUI are two clients of the same daemon.

> **Status: built and tested; not yet mounted.** The API server (`src/daemon/console-api.ts`) and the client (`src/console/`) exist and are covered by a real-browser suite. The daemon does not yet *serve* them in production — that wiring, plus the operator-token lifecycle and static serving, is task [T-1001](delivery/tasks/T-1001-console-mounted-at-boot.md). Until it lands, the console runs in tests, not in your browser. This document describes the built system and, where marked, the T-1001 wiring.

---

## Running it

**Today (before T-1001):** the console runs inside the test suite. Drive it yourself with:

```sh
bun test tests/console-client.test.ts   # real headless Chrome against a live daemon
```

**After T-1001:** `omp-agent daemon` prints the console URL at boot, e.g. `http://127.0.0.1:PORT/?token=…`. The token is generated on first boot, stored mode-0600 under the daemon's state dir, and reused on restart; delete the file to rotate. Everything binds loopback — the console is for the local operator.

## Architecture

```
browser ── HTTP (Bearer) ──┐
        └─ WebSocket (?token=) ──┤
                                 ▼
                 ┌── src/daemon/console-api.ts ──┐
                 │  token gate → routes → store   │──▶ Supervisor.post() (wakes agents)
                 │  live feed (poll while open)   │──▶ RoomStore (durable state)
                 └────────────────────────────────┘
```

- **One seam for writes:** every message the console posts goes through `Supervisor.post()`, never the store directly — that is what wakes subscribed agents. A console that wrote straight to the store would leave agents silent.
- **Live updates without polling from the browser:** the browser holds a WebSocket; the server polls the durable store (only while a console is connected) and pushes diffs. An unattended daemon does no console work.
- **The human is `@you`:** the console posts as the human sentinel, and any write claiming an agent's name is refused (403) — a transcript where a browser can impersonate an agent is untrustworthy.

## HTTP API

All routes require the operator token: `Authorization: Bearer <token>` on HTTP, `?token=` on the WebSocket handshake (browsers can't set headers there). Errors are `{"error": {"code", "message"}}` with statuses 400/401/403/404/405/500.

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

Dependency-free plain JS (`app.js` with JSDoc types), HTML shell, CSS — no build step. Three panes: channels, transcript with composer, and a side thread pane (replies never crowd the channel root). Reactions render as `emoji ×count` chips and toggle the operator's own on click. Management forms (T-605): create an agent, create a channel, manage a running agent's room membership.

## Security model

- Loopback-only by default; the operator token gates every route; comparison is constant-time over digests.
- Agent-authored writes refused; the human posts as `@you`.
- Agent hierarchy (`parent`/`children`) is display metadata — **nothing is enforced off it** (ADR-011). If the console ever binds beyond loopback or parentage needs authority, [T-1004](delivery/tasks/T-1004-control-socket-identity.md) (connection identity) is the named precondition.

## Testing

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

Design decisions live in [ADR-009](delivery/adr/ADR-009-threads-and-reactions.md) (threads/reactions) and [ADR-011](delivery/adr/ADR-011-agent-hierarchy.md) (hierarchy's cooperative metadata). The tasks that built it: T-601, T-602, T-603, T-605; the one that serves it for real: T-1001.
