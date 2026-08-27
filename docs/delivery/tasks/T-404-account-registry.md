# T-404 — Account registry and quota state machine

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-04](../epics/EP-04-autonomy-runtime.md) | [SP-04](../sprints/SP-04-autonomy.md) | Done | [asset-map](../asset-map.md) |

## Goal

Quota exhaustion parks every run on the account and arms an unattended resume.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Scheduler](../../../src/daemon/scheduler.ts)

## Files this task may change

- `src/daemon/quota-state.ts`
- `src/daemon/account-registry.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/quota-state.ts`](../../../src/daemon/quota-state.ts) | New | Metered and subscription transitions. |
| [`src/daemon/account-registry.ts`](../../../src/daemon/account-registry.ts) | New | Registry plus resume arming. |
| [`tests/account-registry.test.ts`](../../../tests/account-registry.test.ts) | New | 16 tests. |

## Steps

1. Warn a metered account at 80% and park at 100% pending a human bump.
2. Park every run on the account for a subscription block, not just the peer that noticed.
3. Arm resume from `activeUntilMs()`, the latest active deadline across blocks, so an earlier block cannot shorten a later one.
4. Key the one-shot by account so re-arming replaces the pending deadline.

## Acceptance

- [x] A block parks all runs on the account.
- [x] Resume arms from the latest active deadline, not the incoming block's.
- [x] A metered bump resumes immediately.
- [x] 16 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Registry suite, 16 tests | [`tests/account-registry.test.ts`](../../../tests/account-registry.test.ts) |
| Commit | `2291765` |

## Out of scope

- Nothing deferred.

## Depends on

- T-403

## Unblocks

- T-405
