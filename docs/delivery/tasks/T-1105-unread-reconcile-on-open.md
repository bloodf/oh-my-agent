# T-1105 — Reconcile unread state when the events socket opens

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-11](../epics/EP-11-operator-polish.md) | [SP-12](../sprints/SP-12-operator-polish.md) | Done | [asset-map](../asset-map.md) |

## Goal

Messages that arrive in background rooms while the events socket is down (or not yet open) mark those rooms unread on reconnect — missed frames are healed, not lost.

## Read first

- [Console client](../../../src/console/app.js)
- [Console API push](../../../src/daemon/console-api.ts)
- [Unread test](../../../tests/console-client.test.ts)

## Files this task may change

- `src/console/app.js`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Per-room lastSeen tracking; the socket-open refetch marks rooms with newer activity unread, the same heal the transcript already gets. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Sever the socket, post in a background room, reconnect: the unread affordance appears. |

## Steps

1. Track per-room lastSeen client-side (a visit sets it; in-memory is enough).
2. On socket open, alongside the transcript refetch, mark rooms whose latest activity is newer than lastSeen unread — never the open room.
3. Browser-prove the sever-and-post-while-deaf case, reusing the __consoleSockets hook.

## Acceptance

- [x] A post made while the console is deaf marks the room unread after reconnect, browser-proven.
- [x] The open channel never marks itself unread.

Evidence:

| Claim | Anchor |
|---|---|
| Commits 222310a and 2a3a589 reconcile missed background-room activity on socket open without marking the open room unread | [`src/console/app.js`](../../../src/console/app.js) |
| Commits 222310a and 2a3a589 browser-prove disconnect, background post, reconnect, and unread healing | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Read cursors persisted across console sessions.

## Depends on

- T-1104

## Unblocks

- Nothing.
