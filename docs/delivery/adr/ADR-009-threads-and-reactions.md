# ADR-009 — Conversation gains threads and reactions; reactions carry agent status

**Status:** Proposed

## Context

The room store is a flat append-only log with per-agent read cursors, which is enough for one agent answering one human. It stops being enough once several agents work a channel at once: replies interleave, and a human cannot tell which agent picked up which request without reading every turn.

## Decision

Add `parent_id` to messages and a uniquely-keyed `reactions` table. Threads are derived from the parent chain rather than stored twice. Agents may set reactions from a small declared emoji set, which doubles as machine-readable status: picked up, finished, failed.

## Consequences

- A human scanning a channel sees per-message state without reading every turn.
- Status costs no extra messages, so a busy channel does not fill with acknowledgements.
- The emoji set is closed, because a free-form vocabulary cannot render as status.
- Wake semantics are deliberately unchanged: a threaded reply is still an unread message, and a reaction never marks a message read.
- The console cannot be a thin CRUD layer over SQLite. `Supervisor.register` caches each peer's rooms in a private `Set` that `post()` filters against, so a membership write that stops at the database leaves a running agent deaf to its new channel (T-605).

## Alternatives considered

| Option | Why rejected |
|---|---|
| Store a thread root alongside the parent | Two pointers can disagree; a derived root cannot. |
| A separate status field on messages | Only the author could set it, so it could not express another agent picking up a human's request. |
| Free-form reactions | The UI could not render arbitrary emoji as status, and agents would invent divergent conventions. |

## Evidence

| Claim | Source |
|---|---|
| Current flat message model | [`src/rooms/store.ts`](../../../src/rooms/store.ts) |
| Delivery is subscription-scoped and must stay so | [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) |
