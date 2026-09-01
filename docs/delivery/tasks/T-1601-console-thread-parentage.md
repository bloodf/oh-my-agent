# T-1601 — Console thread replies preserve parentage

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A thread reply posted from the console lands in the thread because parentId flows from the console POST through the API and supervisor into RoomStore.post().

## Read first

- [Console API post handler](../../../src/daemon/console-api.ts)
- [Supervisor post chain](../../../src/daemon/supervisor.ts)
- [Console thread composer](../../../src/console/app.js)
- [Thread keyboard regression](../../../tests/console-client.test.ts)

## Files this task may change

- `src/daemon/console-api.ts`
- `src/daemon/supervisor.ts`
- `src/console/app.js`
- `tests/console-api.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Parses parentId and returns RoomStore validation errors as HTTP 400. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Carries parentId through the post API into RoomStore.post(). |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Sends the open thread root id from the thread composer. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Covers parentId flow and client-visible validation errors. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Asserts keyboard replies render inside the pane and removes the stale workaround comment. |

## Steps

1. Add parentId to the console POST parser and the API-to-supervisor chain; leave validation in RoomStore, its existing owner.
2. Send the open thread root id from the thread composer and render a returned 400 validation error in the client.
3. Change the thread keyboard test's reply section to assert the reply lands inside the pane, never as a root, and delete the stale server-side-gap comment.

## Acceptance

- [ ] Browser-proven: a keyboard reply from the thread pane renders inside the pane and never as a root.
- [ ] The stale workaround comment in the thread keyboard test is gone.
- [ ] Store validation errors surface as a 400 the client renders.

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
