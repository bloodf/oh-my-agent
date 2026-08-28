# T-402 — Durable room store

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-04](../epics/EP-04-autonomy-runtime.md) | [SP-04](../sprints/SP-04-autonomy.md) | Done | [asset-map](../asset-map.md) |

## Goal

Rooms, messages, and per-agent read cursors survive a daemon restart.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `src/rooms/store.ts`
- `tests/rooms.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | New | SQLite-backed bus. |
| [`tests/rooms.test.ts`](../../../tests/rooms.test.ts) | New | 25 tests. |

## Steps

1. Create `rooms`, `messages`, and `subscriptions` tables with a channel-or-dm check constraint.
2. Track `last_read_id` per agent per room.
3. Return pending messages per agent; note the `LEFT JOIN` means a subscribed room always yields an entry with an empty list, so callers filter on length rather than expecting no entry.

## Acceptance

- [x] Messages and cursors persist across store reopen.
- [x] `unreadCount` reflects posts since the cursor.
- [x] `pendingForAgent` returns an empty message list, not a missing entry, for a quiet subscribed room.
- [x] 25 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Room suite, 25 tests | [`tests/rooms.test.ts`](../../../tests/rooms.test.ts) |
| Commit | `96e7d9d` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-405
