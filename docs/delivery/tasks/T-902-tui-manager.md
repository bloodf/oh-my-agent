# T-902 — Full-screen agent manager

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-09](../epics/EP-09-tui-management.md) | [SP-10](../sprints/SP-10-tui-management.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A full-screen overlay inside the OMP TUI is the operator's management surface for the agent tree.

## Read first

- [Extension factory](../../../src/extension/index.ts)
- [OMP custom-surface API](../../../node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)

## Files this task may change

- `src/extension/manager.ts`
- `src/extension/index.ts`
- `tests/extension.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/extension/manager.ts` (to be created) | New | The overlay component: tree browse, per-agent action menu, kill with cascade choice, logs, inject, membership editing. |
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | Registers `/manage` and a shortcut; guards `ctx.hasUI`/`ctx.mode`. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | Manager state logic against the real socket; the component is split so logic is testable without a TTY. |

## Steps

1. SPIKE FIRST and timebox it: a minimal full-screen overlay rendering the tree and dismissing on Esc, proven in a real OMP TUI session by hand before building further — `ctx.ui.custom` with `overlay: true, fullscreen: true` is the least-documented surface in play.
2. Split the manager into a pure state layer (tree model, selected node, pending action) and the component factory, so the suite drives the state layer against the real socket without a TTY.
3. Actions per agent: edit definition/model (T-903's flows), logs, inject, kill — with the cascade choice presented explicitly (`kill subtree` vs `keep children`).
4. Degrade: without a TUI the command reports that the manager needs one; without a daemon it says so and offers nothing broken.

## Acceptance

- [ ] The overlay opens over the transcript, browses the tree by keyboard, and closes cleanly without disturbing the session.
- [ ] Every action goes through the daemon socket; the manager holds no state the daemon does not own.
- [ ] The state layer is covered by tests driving the real socket; the spike's risks are named in the report.

## Out of scope

- Editing flows themselves, which are T-903.

## Depends on

- T-901

## Unblocks

- Nothing.
