# T-901 — Hierarchy in /agents and the spawn flow

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-09](../epics/EP-09-tui-management.md) | [SP-10](../sprints/SP-10-tui-management.md) | Ready | [asset-map](../asset-map.md) |

## Goal

`/agents` renders the agent tree, and `/spawn` can parent a new peer.

## Read first

- [Commands](../../../src/extension/commands.ts)
- [Widget](../../../src/extension/widget.ts)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)

## Files this task may change

- `src/extension/commands.ts`
- `src/extension/widget.ts`
- `tests/extension.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | Tree rendering in `/agents`; parent picker in `/spawn`; orphan flag visible. |
| [`src/extension/widget.ts`](../../../src/extension/widget.ts) | Edited | Widget counts stay flat (roots + children); the tree belongs to the command and the manager. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | Tree shape assertions over the real socket. |

## Steps

1. Render `/agents` as an indented tree from the status payload's parent/children fields, with the shield and the orphaned marker.
2. `/spawn` gains an optional parent selection (a `select` dialog over live peers; root when declined).
3. Keep the string-array widget as-is — it caps at ten lines and the tree does not belong there.

## Acceptance

- [ ] A child renders nested under its parent; an orphaned peer is flagged.
- [ ] Spawning with a chosen parent lands the child under it, visible on the next `/agents`.
- [ ] Every flow degrades cleanly when the daemon is absent.

## Out of scope

- The full-screen manager, which is T-902.

## Depends on

- T-802

## Unblocks

- T-902
- T-903
