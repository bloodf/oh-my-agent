# T-1503 — Remove the node_modules walk once upstream ships

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

When a released pi-coding-agent fixes the resolution corruption, the node_modules walk in resolveOmpCli is deleted and the dependency floors rise to the fix version — one fix, one removal.

## Read first

- [The walk](../../../src/worker/lifecycle.ts)
- [Worker lifecycle suite](../../../tests/worker-lifecycle.test.ts)
- [Dependency ranges](../../../package.json)

## Files this task may change

- `src/worker/lifecycle.ts`
- `package.json`
- `bun.lock`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | The walk collapses back to a direct import.meta.resolve. |
| [`package.json`](../../../package.json) | Edited | The peer AND dev dependency floors rise to the released fix version. |
| [`bun.lock`](../../../bun.lock) | Edited | Refreshed against the raised floors. |

## Steps

1. Pick this up WHEN a released pi-coding-agent contains the resolution fix (T-1502's memo-corruption issue closed).
2. Remove the walk, raise the peer and dev dependency floors to the released fix version, and refresh the lockfile.
3. Regression coverage comes from the existing worker-lifecycle suite — real spawned workers with pid semantics — run green on the upgraded dependency.

## Acceptance

- [ ] No node_modules walk remains in resolveOmpCli; the worker-lifecycle suite is green on the upgraded dependency.

## Out of scope

- Waiting on the upstream release, which is outside this repo's control; this task stays Blocked until T-1502's issue closes.

## Depends on

- T-1502

## Unblocks

- Nothing.
