# T-705 — Time budget for process-spawning tests

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-07](../epics/EP-07-release-readiness.md) | [SP-08](../sprints/SP-08-release-readiness.md) | Done | [asset-map](../asset-map.md) |

## Goal

Real-child tests stop flaking at the default 5s budget when the machine is busy — without weakening what they assert.

## Read first

- [Deflake task](../../../docs/delivery/tasks/T-704-deflake-intermittent-test.md)
- [Working rules](../../../docs/delivery/README.md)

## Files this task may change

- `package.json`
- `.github/workflows/ci.yml`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`package.json`](../../../package.json) | Edited | The test script carries the budget. |
| [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | Edited | CI runs with the same budget. |

## Steps

1. Distinguish the two flake classes: T-704's deterministic resolver corruption (fixed at the mechanism) from environment-throughput delay, where a child that needs ~1s idle needs >5s under load and the assertion itself is not time-dependent.
2. Set `bun test --timeout 30000` in the test script and CI, because the alternative — per-call-site budgets across four real-child files — is forty edits that say the same thing.
3. Do not touch any assertion; a logic race would still fail, just later.

## Acceptance

- [x] Ten consecutive full-suite runs under normal load pass, including runs immediately after heavy parallel sessions.
- [x] No test's assertion changed in the same change.

Evidence:

| Claim | Anchor |
|---|---|
| Budget in the test script and CI | [`./package.json`](../../.././package.json) |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
