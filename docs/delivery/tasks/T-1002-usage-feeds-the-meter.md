# T-1002 — Usage feeds the meter

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A metered account's meter moves with real usage, so the 80% warning and 100% park (T-506) fire on reality.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Credential gateway usage routes](../../../src/daemon/credential-gateway.ts)
- [Account registry](../../../src/daemon/account-registry.ts)
- [Supervisor budget flow](../../../src/daemon/supervisor.ts)

## Files this task may change

- `src/daemon/main.ts`
- `src/daemon/account-registry.ts`
- `src/shared/agent-definition.ts`
- `tests/usage-meter.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | The account→credential binding at spawn (worker tokens stop being bound to zero credentials) and the usage polling loop. |
| [`src/daemon/account-registry.ts`](../../../src/daemon/account-registry.ts) | Edited | updateMeter is driven with a dollars-burned fraction computed from usage. |
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | Edited | An account/credential field on the definition, if the binding is declared there — decide and document. |
| `tests/usage-meter.test.ts` (to be created) | New | Usage moves the meter; the 80% warning posts; the park fires at the cap; no usage means no movement. |

## Steps

1. Bind worker tokens to the account's credentials instead of an empty list (the current `credentialIds: []` placeholder in main.ts is the gap — an unbound token sees nothing).
2. Poll the gateway's usage routes on an interval and convert dollars to the 0..1 meter per metered account (`budgetUsd` is the denominator).
3. Drive `registry.updateMeter`; the T-506 warn/park/bump flow does the rest, unchanged.
4. Stop polling when nothing is running; an unattended daemon does not burn gateway calls.

## Acceptance

- [ ] Reported usage moves the meter, and crossing 80% posts the warning naming the account and budget.
- [ ] Reaching the cap parks the account's runs; a bump resumes them (T-506's tests keep passing).
- [ ] A subscription account's meter never moves.

## Out of scope

- Usage display in the TUI/console (read models exist; presenting them is a future UI task).

## Depends on

- T-301
- T-506

## Unblocks

- Nothing.
