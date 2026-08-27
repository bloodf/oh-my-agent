# T-005 — Spawn policy enforcement contract

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-00](../epics/EP-00-foundations-and-contracts.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

`spawns:` enforcement and the `task.disabledAgents` preflight are pinned against OMP.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `tests/contracts/spawn-policy.contract.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/contracts/spawn-policy.contract.test.ts`](../../../tests/contracts/spawn-policy.contract.test.ts) | New | Pins enforcement. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Read only, not edited by this task | Implements the classification. |

## Steps

1. Assert an explicit `tools:` list replaces rather than extends the default set, which is how `task` gets silently stripped.
2. Assert the disabled-agents snapshot is enumerated at spawn.
3. Cover the peer versus coding-subtask distinction.

## Acceptance

- [x] 23 tests pass.
- [x] Stripping `task` from a `tools:` list is detectable by test, not by production surprise.

Evidence:

| Claim | Anchor |
|---|---|
| Spawn policy contract, 23 tests | [`tests/contracts/spawn-policy.contract.test.ts`](../../../tests/contracts/spawn-policy.contract.test.ts) |
| Commit | `4cba1ad` |

## Out of scope

- Nothing deferred.

## Depends on

- T-002

## Unblocks

- T-401
