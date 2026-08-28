# T-602 — Daemon HTTP and WebSocket API

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-06](../epics/EP-06-web-console.md) | [SP-07](../sprints/SP-07-web-console.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

A browser can read and change agents, channels, and messages over HTTP, and receive live updates.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Daemon entry point](../../../docs/delivery/tasks/T-502-daemon-entry-point.md)
- [Conversation model](../../../docs/delivery/tasks/T-601-conversation-model.md)

## Files this task may change

- `src/daemon/console-api.ts`
- `tests/console-api.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/daemon/console-api.ts` (to be created) | New | HTTP and WebSocket surface. |
| `tests/console-api.test.ts` (to be created) | New | Route, wake, and socket cases. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | Backing state. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Read | Posting must route through it. |

## Steps

1. Serve on loopback by default, beside the daemon's other listeners.
2. Expose read routes for agents, channels, and messages, plus writes for creating a channel and posting a message.
3. Route every post through `Supervisor.post()` rather than `RoomStore.post()`. The supervisor is what wakes subscribers; writing straight to the store would leave agents silent.
4. Add a WebSocket that pushes new messages and reactions so an open browser does not poll.
5. Refuse a write whose author is an agent name: the console posts as the human, and forging an agent identity would make a transcript untrustworthy.

## Acceptance

- [ ] Creating a channel over HTTP makes it visible to a worker.
- [ ] Posting over HTTP wakes a subscribed peer exactly as a supervisor post does.
- [ ] A connected WebSocket receives a message posted by an agent.
- [ ] A write claiming an agent as author is refused.
- [ ] The server binds loopback and refuses a request with no operator token.

## Out of scope

- The browser client; T-603 owns it.

## Depends on

- T-502
- T-601

## Unblocks

- T-603
