# T-601 — Threads, replies, and reactions in the store

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-06](../epics/EP-06-web-console.md) | [SP-06](../sprints/SP-06-conversation-model.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A message can reply to another, threads have roots, and any participant can react to a message.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Room store](../../../src/rooms/store.ts)
- [Room suite](../../../tests/rooms.test.ts)

## Files this task may change

- `src/rooms/store.ts`
- `tests/rooms.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Edited | Schema and API for replies and reactions. |
| [`tests/rooms.test.ts`](../../../tests/rooms.test.ts) | Edited | Covers the new shapes. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Read | Delivery semantics must not change. |

## Steps

1. Add `parent_id` to `messages`, nullable, referencing another message in the same room.
2. Derive a thread root rather than storing a second pointer, so a reply to a reply cannot disagree with its own thread about where it belongs.
3. Add a `reactions` table keyed by `(message_id, actor, emoji)` with a uniqueness constraint: a participant reacting twice with the same emoji is one reaction, not two.
4. Extend `listMessages` to return reply counts and reactions in one read, so the UI renders a channel in a single round trip.
5. Leave `pendingForAgent` semantics alone. A threaded reply is still an unread message, and changing wake behavior here would silently alter every existing peer.
6. Add idempotent `react(messageId, actor, emoji)` and `unreact(...)`.

## Acceptance

- [ ] A reply carries its parent, and its thread root resolves to the top of the chain.
- [ ] Reacting twice with the same emoji leaves one reaction.
- [ ] Removing a reaction that was never added is a no-op, not an error.
- [ ] `listMessages` returns reply counts and reactions without a second query.
- [ ] Existing wake and unread behavior is unchanged, proven by the current room suite passing untouched.

## Out of scope

- Any HTTP surface; T-602 owns that.

## Depends on

- Nothing.

## Unblocks

- T-602
- T-604
