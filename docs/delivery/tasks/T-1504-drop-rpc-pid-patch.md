# T-1504 — Remove the RpcClient.pid patch once upstream ships

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

When a released pi-coding-agent ships the RpcClient.pid accessor, the patchedDependencies entry and the patch file are deleted, the dependency floors rise to the fix version, and everything that references patches/ is updated.

## Read first

- [patchedDependencies](../../../package.json)
- [The patch](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch)
- [The pack test that references patches/](../../../docs/delivery/tasks/T-1301-packable-artifact.md)

## Files this task may change

- `package.json`
- `patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`
- `tests/pack.test.ts`
- `.github/workflows/release.yml`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`package.json`](../../../package.json) | Edited | The patchedDependencies entry is removed; the peer and dev dependency floors rise to the released fix version. |
| [`patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch) | Edited | Deleted; this row records the removal. |
| [`tests/pack.test.ts`](../../../tests/pack.test.ts) | Edited | Created by T-1301; the patches/ presence assertions come out. |
| [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) | Edited | Created by T-1303; the pid contract state flips to 'pid present'. |

## Steps

1. Pick this up WHEN a released pi-coding-agent contains the pid accessor (T-1502's accessor issue closed).
2. Remove the patchedDependencies entry and the patch file, raise the dependency floors to the fix version, and refresh the lockfile.
3. Update the consumers of patches/: the pack test's assertions and the release workflow's contract-state assert (per amended ADR-013, the state flips to 'pid present' and the same consumer smoke test enforces it).

## Acceptance

- [ ] No patchedDependencies entry and no patch file remain; the suites are green on the upgraded dependency.
- [ ] The pack test and release workflow no longer reference patches/, and the consumer smoke test asserts 'pid present'.

## Out of scope

- Remaining blocker: wait for a released pi-coding-agent version containing the RpcClient.pid accessor tracked by T-1502; an upstream filing alone does not unblock patch removal.

## Depends on

- T-1502

## Unblocks

- Nothing.
