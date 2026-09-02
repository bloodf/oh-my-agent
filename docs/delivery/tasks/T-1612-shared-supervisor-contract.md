# T-1612 — Shared supervisor backend contract

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

One supervisor contract suite drives both worker backends and boot-level tests prove the default backend decision.

## Read first

- [Subprocess worker behavior](../../../tests/worker-lifecycle.test.ts)
- [In-process worker behavior](../../../tests/worker-inprocess.test.ts)
- [Existing contract suite pattern](../../../tests/contracts/discovery.contract.test.ts)

## Files this task may change

- `tests/contracts/supervisor-contract.test.ts`
- `tests/worker-inprocess.test.ts`
- `tests/worker-lifecycle.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/contracts/supervisor-contract.test.ts`](../../../tests/contracts/supervisor-contract.test.ts) | New | Reusable supervisor contract run against startWorker and startInProcessWorker. |
| [`tests/worker-inprocess.test.ts`](../../../tests/worker-inprocess.test.ts) | Edited | Instantiates the shared contract and proves boot selection with inProcessWorkers true. |
| [`tests/worker-lifecycle.test.ts`](../../../tests/worker-lifecycle.test.ts) | Edited | Instantiates the shared contract and proves boot selection with inProcessWorkers false. |

## Steps

1. Extract observable supervisor invariants into one contract factory and run it unchanged against both worker starters.
2. Boot without workerFactory under inProcessWorkers true and false; assert selected backend invariants including pid and sandboxed.
3. Keep backend-specific tests only for behavior not shared by the contract.

## Acceptance

- [x] The same suite runs against startWorker and startInProcessWorker.
- [x] A boot with no workerFactory and inProcessWorkers true/false asserts the selected backend's invariants (pid, sandboxed).

Evidence:

| Claim | Anchor |
|---|---|
| one supervisor contract drives both backends; boot-selection proven without a factory | [`tests/contracts/supervisor-contract.test.ts`](../../../tests/contracts/supervisor-contract.test.ts) |
| Commit | `2f5325b` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
