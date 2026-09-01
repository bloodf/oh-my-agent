# T-1503 — Remove the walk and the patch once upstream ships

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Planned | [asset-map](../asset-map.md) |

## Goal

When a released pi-coding-agent contains both fixes, the node_modules walk in resolveOmpCli and the patchedDependencies entry are deleted in one change, with the contract suites proving nothing relied on them.

## Read first

- [The walk](../../../src/worker/lifecycle.ts)
- [patchedDependencies](../../../package.json)
- [The patch](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch)

## Files this task may change

- `src/worker/lifecycle.ts`
- `package.json`
- `patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | The walk collapses back to a direct import.meta.resolve. |
| [`package.json`](../../../package.json) | Edited | The patchedDependencies entry is removed. |
| [`patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch) | Edited | Deleted; this row records the removal. |

## Steps

1. Pick this up WHEN a released pi-coding-agent contains both fixes (T-1502's issues closed).
2. Remove the walk and the patch and upgrade the pinned version.
3. Full suite plus contract suites: the failure modes the workarounds covered are now covered by upstream behavior, asserted by the existing contracts.

## Acceptance

- [ ] No node_modules walk and no patchedDependencies entry remain; the suites are green on the upgraded dependency.

## Out of scope

- Waiting on upstream releases outside this repo's control; this task stays Planned until T-1502's issues close.

## Depends on

- Nothing.

## Unblocks

- Nothing.
