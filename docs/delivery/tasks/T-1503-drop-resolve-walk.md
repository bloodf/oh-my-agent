# T-1503 — Remove the node_modules walk once upstream ships

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

When a released runtime or a released compat layer removes the re-entrant resolution, the node_modules walk in resolveOmpCli is deleted and the floor that made it removable rises to the fix version — one fix, one removal.

## Read first

- [The walk](../../../src/worker/lifecycle.ts)
- [Worker lifecycle suite](../../../tests/worker-lifecycle.test.ts)
- [Dependency ranges and the Bun engine floor](../../../package.json)
- [The repro whose control names the defect](../../../repro/bun-plugin-memo/README.md)

## Files this task may change

- `src/worker/lifecycle.ts`
- `package.json`
- `bun.lock`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | The walk collapses back to a direct import.meta.resolve. |
| [`package.json`](../../../package.json) | Edited | Whichever fix shipped sets the floor: engines.bun for the Bun path, or the pi-coding-agent peer AND dev floors for the compat-layer path. |
| [`bun.lock`](../../../bun.lock) | Edited | Refreshed only on the compat-layer path, where the pi-coding-agent floors move a resolved dependency; a Bun engines floor changes no resolution and leaves this file untouched. |

## Steps

1. Pick this up WHEN EITHER a released Bun contains the resolver fix (oven-sh/bun#41201, the tracker T-1501's bare control selected), OR a released pi-coding-agent stops its compat hook resolving the specifier it just matched. T-1501's control — a hand-written onResolve hook overflowing with no OMP package on disk and no OMP code in the process — puts the defect in Bun; a compat-layer change does not fix Bun, but it does remove this app's trigger, so either release makes the walk removable.
2. Remove the walk and raise only the floor that earned it: engines.bun for a Bun fix, the peer and dev pi-coding-agent floors for a compat-layer fix. Refresh the lockfile only on the compat-layer path — raising engines.bun resolves no dependency and must not produce a lockfile diff.
3. Regression coverage comes from the existing worker-lifecycle suite — real spawned workers with pid semantics — run green on the upgraded runtime or dependency.

## Acceptance

- [ ] No node_modules walk remains in resolveOmpCli; the worker-lifecycle suite is green on the upgraded runtime or dependency.
- [ ] The raised floor names the release that actually removed the re-entrancy: engines.bun for a Bun fix, or the pi-coding-agent floors for a compat-layer fix.

## Out of scope

- Remaining blocker: wait for a released Bun containing the resolver fix (oven-sh/bun#41201), or a released pi-coding-agent whose compat hook no longer self-resolves. An upstream filing alone does not unblock removal, and a merged-but-unreleased fix does not either.

## Depends on

- T-1502

## Unblocks

- Nothing.
