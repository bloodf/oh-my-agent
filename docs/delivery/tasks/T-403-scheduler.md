# T-403 — Cron and one-shot scheduler

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-04](../epics/EP-04-autonomy-runtime.md) | [SP-04](../sprints/SP-04-autonomy.md) | Done | [asset-map](../asset-map.md) |

## Goal

Schedules fire on Vixie cron semantics, and one-shot timers drive quota resume.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `src/daemon/scheduler.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/scheduler.ts`](../../../src/daemon/scheduler.ts) | New | `nextCronTime`, `addOnce`. |
| [`tests/scheduler.test.ts`](../../../tests/scheduler.test.ts) | New | 47 tests. |

## Steps

1. Implement `nextCronTime` with the four explicit Vixie day branches, since restricted DOM and DOW is a union rather than an intersection.
2. Add version-guarded `addOnce`, where re-arming the same job name replaces the pending deadline.
3. Fire immediately for a deadline already in the past.

## Acceptance

- [x] Both-restricted day fields match the union.
- [x] Re-arming a job name replaces rather than duplicates its timer.
- [x] A past deadline fires immediately.
- [x] 47 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Scheduler suite, 47 tests | [`tests/scheduler.test.ts`](../../../tests/scheduler.test.ts) |
| Commits | `2409cb9, 22b6a97, b88bab5` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-404
