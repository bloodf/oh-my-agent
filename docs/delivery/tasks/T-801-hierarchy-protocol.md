# T-801 — Hierarchy and authoring protocol

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-08](../epics/EP-08-agent-hierarchy.md) | [SP-09](../sprints/SP-09-agent-hierarchy.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The control protocol can create definitions, spawn children, and read and update definitions — additively, no version bump.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Protocol](../../../src/shared/protocol.ts)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)

## Files this task may change

- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `tests/protocol.contract.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | New methods `agent_create`, `definition_get`, `definition_update`; `agent_spawn` gains optional `parent`; `AgentStatus` gains optional `parent` and `children`. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Validators for every new and widened shape. |
| [`tests/protocol.contract.test.ts`](../../../tests/protocol.contract.test.ts) | Edited | The exact method set grows; fixtures for each addition. |

## Steps

1. Add `agent_create` params mirroring the peer-store write fields (`name`, `description`, `model?`, `rooms?`, `wake?`, `autonomy?`, `spawns?`, `body`), result `{name, created: boolean}` — `created:false` when the definition already existed unchanged.
2. Add `definition_get` `{name}` → the parsed definition plus its source path; `definition_update` `{name, changes}` → `{name, rebuildRequired: boolean}` so a caller learns whether a live worker will rebuild.
3. Widen `agent_spawn` with optional `parent` (a peer name) and `AgentStatus` with optional `parent?: string` and `children?: string[]`.
4. Update the contract suite's exact-set test and add valid/invalid fixtures per new shape; the no-bump policy note in the protocol header stays accurate.

## Acceptance

- [ ] Every new method and field validates on params and results, with the offending field named on refusal.
- [ ] The exact method set in the contract suite matches the implementation.
- [ ] Older clients remain wire-compatible: every added field is optional.

## Out of scope

- Serving any of it, which is T-802; TUI consumption, which is EP-09.

## Depends on

- T-507
- T-605

## Unblocks

- T-802
- T-903
