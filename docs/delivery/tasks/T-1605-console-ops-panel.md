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
- `src/console/app.js`
- `src/console/index.html`
- `src/console/style.css`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Exposes operator-authenticated kill, inject, logs-tail, and budget-bump routes. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Runs all four operations, including subtree confirmation and typed-event refresh. |
| [`src/console/index.html`](../../../src/console/index.html) | Edited | Adds semantic controls and the logs tail view. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Styles the operations panel and accessible confirmation state. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proves operations and keyboard-only accessibility. |

## Steps

1. Expose the four existing operator capabilities through console API routes without adding another auth model.
2. Add the operations panel; require explicit subtree confirmation before kill and show logs tail and updated budget state.
3. Drive kill, inject, logs, and bump keyboard-only through the browser accessibility assertions.

## Acceptance

- [ ] Browser-proven kill with subtree confirmation, inject, a logs tail view, and a bump with the new budget visible.
- [ ] All four pass the console's accessibility assertions keyboard-only.

## Out of scope

- Nothing deferred.

## Depends on

- T-1604

## Unblocks

- Nothing.
