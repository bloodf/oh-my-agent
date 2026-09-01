# T-1104 — Focus stability across transcript repaints

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-11](../epics/EP-11-operator-polish.md) | [SP-12](../sprints/SP-12-operator-polish.md) | Done | [asset-map](../asset-map.md) |

## Goal

A live transcript repaint never dumps keyboard focus, and the keyboard tests are deterministic against the live feed.

## Read first

- [Console client](../../../src/console/app.js)
- [Browser suite](../../../tests/console-client.test.ts)

## Files this task may change

- `src/console/app.js`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/app.js`](../../../src/console/app.js) | Edited | renderTranscript remembers the focused control (message row, classes, index among same-class controls) and restores it after replaceChildren — the rule the channel list already followed. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | focusInPage replaces two-roundtrip page.focus everywhere; the unread test waits for the events socket; the repaint regression test; explicit 10s on the thread-open selector waits. |

## Steps

1. renderTranscript: capture the focused control keyed by message row, classes, and index among the row's same-class controls before replaceChildren, and restore it after — mirroring renderChannels. Found via the thread keyboard test flaking ~1-in-5: a repaint between page.focus and Enter destroyed the focused opener.
2. focusInPage: one in-page round-trip, mirroring clickInPage. Puppeteer's page.focus resolves the selector and focuses in two CDP round-trips; a repaint between them makes focus() a silent no-op on a detached node. Migrate every page.focus call in the suite.
3. The unread test waits for the events socket to be OPEN before posting: a pre-open post is a missed frame, not a slow one — the open-time refetch heals the transcript, not unreadRooms.
4. Regression test: focus the thread opener, force a repaint with a new post, assert focus survives on the same control and Enter still opens the pane.

## Acceptance

- [x] The repaint regression test fails without the client change and passes with it (revert-verified).
- [x] The console suite runs green repeatedly (12 consecutive full runs) where the thread keyboard test flaked intermittently.

Evidence:

| Claim | Anchor |
|---|---|
| Focus capture/restore in renderTranscript | [`src/console/app.js`](../../../src/console/app.js) |
| focusInPage, socket-open wait, repaint regression test | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Healing unreadRooms for frames missed while the socket was down — filed as T-1105.

## Depends on

- T-1102

## Unblocks

- T-1105
