# T-201 — Synthetic worker root materialization

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-02](../epics/EP-02-worker-isolation.md) | [SP-02](../sprints/SP-02-isolation.md) | Done | [asset-map](../asset-map.md) |

## Goal

Each worker gets a private user root containing only the definitions it is allowed to see.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Discovery contract](../../../tests/contracts/discovery.contract.test.ts)

## Files this task may change

- `src/daemon/materializer.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | New | Staged write and atomic swap. |
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | Read | Supplies the parsed definition and fingerprint. |
| [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) | New | 30 tests. |

## Steps

1. Build the root under `workers/<agent>/home/`, owning `HOME` and all four `XDG_*` variables, because rerooting `PI_CODING_AGENT_DIR` alone leaves generic native roots in play.
2. Write the worker's own definition plus its `spawns:` closure, and nothing else.
3. Emit generated config with a provider override, never a `models:` entry, since config models carry no transport and would bypass the gateway.
4. Validate the gateway endpoint here: reject implicit ports and non-loopback hosts at the boundary rather than compiling a profile the worker cannot dial.
5. Write to a staged tree, then swap by moving the old root aside and restoring it if the swap fails. Never `rm` before `rename`.

## Acceptance

- [x] The materialized `agents/` holds only the worker's definition and its closure.
- [x] A `spawns:` entry with no source definition is rejected.
- [x] A name that would escape the agent dir is rejected.
- [x] A failed swap leaves the previous root intact.
- [x] The endpoint validator rejects an implicit port and a non-loopback host.
- [x] 30 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Materializer suite, 30 tests | [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) |
| Commits | `c0fdf23, 476bda3` |

## Out of scope

- Nothing deferred.

## Depends on

- T-003
- T-101

## Unblocks

- T-401
