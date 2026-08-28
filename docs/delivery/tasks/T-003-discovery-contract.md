# T-003 — Agent discovery precedence contract

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-00](../epics/EP-00-foundations-and-contracts.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

OMP's real discovery order is pinned, including that the plugin's private store is invisible to it.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `tests/contracts/discovery.contract.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/contracts/discovery.contract.test.ts`](../../../tests/contracts/discovery.contract.test.ts) | New | Runs against installed OMP. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Read only, not edited by this task | Consumes this contract. |

## Steps

1. Assert project, user, and native config root precedence against `discoverAgents()`.
2. Assert the plugin's `.omp/<plugin>/agents` path is not a discovery root, which is the whole reason for materialization.
3. Assert `PI_CODING_AGENT_DIR` reroots `getAgentDir()` but does not suppress generic native roots.

## Acceptance

- [x] 9 tests pass against the installed OMP packages.
- [x] A future OMP change to discovery order fails this suite rather than silently leaking definitions.

Evidence:

| Claim | Anchor |
|---|---|
| Discovery contract, 9 tests | [`tests/contracts/discovery.contract.test.ts`](../../../tests/contracts/discovery.contract.test.ts) |
| Commit | `eda0c5b` |

## Out of scope

- Nothing deferred.

## Depends on

- T-002

## Unblocks

- T-101
- T-201
