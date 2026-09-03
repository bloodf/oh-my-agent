# T-1404 — Live-session safety rails

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Done | [asset-map](../asset-map.md) |

## Goal

The harness can never run away with real accounts: a documented abort procedure, an account allowlist and max-bump ceiling enforced as a refusal, and a cleanup phase that always runs.

## Read first

- [The harness this hardens](../../../docs/delivery/tasks/T-1402-dogfood-harness.md)
- [CLI verbs the harness drives](../../../src/daemon/cli.ts)

## Files this task may change

- `scripts/dogfood.ts`
- `docs/dogfooding.md`
- `tests/dogfood.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`scripts/dogfood.ts`](../../../scripts/dogfood.ts) | Edited | Created by T-1402; gains the allowlist/ceiling refusals and the cleanup phase that runs in a finally. |
| [`docs/dogfooding.md`](../../../docs/dogfooding.md) | Edited | Created by T-1401; gains the abort procedure with the exact commands. |
| [`tests/dogfood.test.ts`](../../../tests/dogfood.test.ts) | Edited | Created by T-1402; asserts the refusals and the no-survivors abort against the fixture daemon. |

## Steps

1. Account allowlist and a max-bump ceiling, enforced by the harness as a refusal before any verb runs: an out-of-list account or an above-ceiling bump aborts the session.
2. Cleanup phase in scripts/dogfood.ts: cascade-kill every spawned agent and disarm every schedule, run in a finally so a failed phase still cleans up.
3. Abort procedure in the runbook: kill the daemon pid, verify the workers die with it — the exact commands named.

## Acceptance

- [x] The harness refuses an account outside the allowlist or a bump above the ceiling.
- [x] An abort during any phase leaves no running worker and no armed schedule, suite-proven against the fixture daemon.
- [x] The runbook's abort section names the exact commands.

Evidence:

| Claim | Anchor |
|---|---|
| Account and bump ceilings are enforced before live verbs, with unconditional cleanup | [`scripts/dogfood.ts`](../../../scripts/dogfood.ts) |
| Refusal and cleanup behavior covers restart and schedule-control failures | [`tests/dogfood.test.ts`](../../../tests/dogfood.test.ts) |
| Required allowlist, ceiling, abort, and cleanup commands are documented | [`docs/dogfooding.md`](../../../docs/dogfooding.md) |

## Out of scope

- A `daemon stop` CLI verb; the abort procedure documents the pid path instead.

## Depends on

- T-1402

## Unblocks

- T-1403
