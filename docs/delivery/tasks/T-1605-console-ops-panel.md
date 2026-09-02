# T-1605 — Console operations panel

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

Kill, inject, logs tail, and budget bump are operable from the authenticated console with subtree confirmation for kills.

## Read first

- [Typed panel state](../../../docs/delivery/tasks/T-1604-typed-daemon-events.md)
- [Console API](../../../src/daemon/console-api.ts)
- [Console interaction model](../../../src/console/app.js)

## Files this task may change

- `src/daemon/console-api.ts`
- `src/daemon/operations.ts`
- `src/daemon/socket.ts`
- `src/daemon/main.ts`
- `src/console/app.js`
- `src/console/index.html`
- `src/console/style.css`
- `tests/console-client.test.ts`
- `tests/console-api.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Exposes operator-authenticated kill, inject, logs-tail, and budget-bump routes. |
| `src/daemon/operations.ts` (to be created) | New | Kill, inject, logs-tail, and bump extracted from the socket handler bodies into one module over DaemonContext; socket handlers and the console API both consume it, so the destructive paths have a single source of truth. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | The four handler bodies become thin delegations to operations.ts. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Wires operations.ts into both the socket context and the console API options at the single construction site. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Runs all four operations, including subtree confirmation and typed-event refresh. |
| [`src/console/index.html`](../../../src/console/index.html) | Edited | Adds semantic controls and the logs tail view. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Styles the operations panel and accessible confirmation state. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proves operations and keyboard-only accessibility. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | The ops routes against a real operations seam: kill/inject/logs/bump round-trip, unknown names 404, parked-inject without rooms 400. |

## Steps

1. Extract src/daemon/operations.ts from the socket.ts handler bodies for kill, inject, logs_tail, and bump (socket.ts ~603-648, ~811-848); the socket handlers become thin delegations, and startConsoleApi gains the seam through main.ts's single construction site. This ruling came from the EP-16 planning review: no other ticket owns the file the wiring must land in.
2. Expose the four existing operator capabilities through console API routes whose handlers delegate to operations.ts, without adding another auth model.
3. Add the operations panel; require explicit subtree confirmation before kill and show logs tail and updated budget state.
4. Drive kill, inject, logs, and bump keyboard-only through the browser accessibility assertions.

## Acceptance

- [ ] Browser-proven kill with subtree confirmation, inject, a logs tail view, and a bump with the new budget visible.
- [ ] All four pass the console's accessibility assertions keyboard-only.

## Out of scope

- Nothing deferred.

## Depends on

- T-1604

## Unblocks

- Nothing.
