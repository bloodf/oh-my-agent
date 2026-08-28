# T-506 — Wire metered budget warnings into rooms

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A metered account's 80% warning reaches a human where they will see it.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Registry](../../../src/daemon/account-registry.ts)
- [Supervisor](../../../src/daemon/supervisor.ts)

## Files this task may change

- `src/daemon/supervisor.ts`
- `tests/supervisor.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | `onWarning` is currently an empty callback. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | Warning and bump cases; T-405 owns the file. |
| [`src/daemon/account-registry.ts`](../../../src/daemon/account-registry.ts) | Read | Already emits the warning. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | Delivery surface. |

## Steps

1. Post the warning into the account's peers' rooms, since a warning only the daemon sees cannot prompt the bump it exists to request.
2. Feed `autonomy.budgetUsd` from the parsed definition into registration, which currently passes no budget.
3. Warn once per threshold crossing rather than on every subsequent turn.

## Acceptance

- [ ] Crossing 80% posts exactly one warning naming the account and its budget.
- [ ] Reaching 100% parks the runs and posts a message saying a bump is required.
- [ ] A bump resumes the account and delivers any backlog.
- [ ] Re-crossing after a bump warns again.

## Out of scope

- Subscription accounts, which never take this path.

## Depends on

- T-502

## Unblocks

- Nothing.
