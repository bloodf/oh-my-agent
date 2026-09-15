# T-1802 — Rooms open on their newest messages and chats stop refetch storms

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-18](../epics/EP-18-review-2026-09.md) | [SP-19](../sprints/SP-19-review-fixes.md) | Done | [asset-map](../asset-map.md) |

## Goal

A room past 500 messages opens on its newest page and pages back on demand. Chat token deltas no longer refetch every open console, unread badges cover rooms never opened, and a failed bootstrap recovers when the socket opens.

## Read first

- [The review findings C-02, C-03, C-05, and C-06](../../../docs/develop/review-2026-09.md)
- [Message paging](../../../src/rooms/store.ts)

## Files this task may change

- `src/rooms/store.ts`
- `src/daemon/console-api.ts`
- `web/src/console/useConsole.ts`
- `web/src/console/Transcript.tsx`
- `web/src/console/ConsoleShell.tsx`
- `tests/rooms.test.ts`
- `tests/console-api.test.ts`
- `tests/console-client.test.ts`
- `docs/web-console.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Edited | newest and beforeId paging with older thread roots included. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | newest and beforeId on the messages route. |
| [`web/src/console/useConsole.ts`](../../../web/src/console/useConsole.ts) | Edited | Newest page on open, load older, per-chat throttled refetch, unread seeding, bootstrap recovery, restart hint, test hooks behind a flag. |
| [`web/src/console/Transcript.tsx`](../../../web/src/console/Transcript.tsx) | Edited | Load older control and scroll anchoring. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | Transcript paging props; chat refetch scoped to the viewed chat. |
| [`tests/rooms.test.ts`](../../../tests/rooms.test.ts) | Edited | Store paging tests. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Messages route paging test. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Large room, delta refetch count, unread, bootstrap, restart hint, and hook tests. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | Messages route query parameters. |

## Steps

1. Add newest and beforeId to the store and route.
2. Open rooms on the newest page with a load-older control.
3. Scope and throttle chat refetches; fix unread and bootstrap recovery.

## Acceptance

- [x] A room with 520 messages shows its newest message on open and loads older history on demand.
- [x] A streaming chat does not refetch per token in consoles that are not viewing it.
- [x] A never-opened room gets an unread badge after a reconnect.

Evidence:

| Claim | Anchor |
|---|---|
| Large-room and refetch browser tests | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
| Store paging tests | [`tests/rooms.test.ts`](../../../tests/rooms.test.ts) |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-1804
