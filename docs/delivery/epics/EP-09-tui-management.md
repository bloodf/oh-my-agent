# EP-09 — Full TUI management surface

**Status:** Ready

*Derived from the tasks below.*

## Outcome

From inside the OMP TUI, an operator browses the agent tree in a full-screen manager and edits agents, their models, and their definitions without leaving the session or hand-editing files.

## Why this is its own epic

The hierarchy makes the flat `/agents` list a lie, and definitions today are edited by writing markdown by hand. OMP's extension surface supports a real full-screen overlay plus editor and selection dialogs, so management belongs inside the TUI the operator already lives in.

## In scope

- Tree rendering of the agent hierarchy in `/agents` and the spawn flow's parent picker.
- A full-screen manager (custom overlay component): browse, inspect, edit, kill with cascade choice, logs, inject.
- Definition and model editing through editor dialogs, persisting through the daemon's write path.

## Not in scope

- RPC/print-mode parity — the manager is TUI-only by design and degrades to the existing commands.
- Editing schedules or accounts (existing commands already cover those).

## Acceptance

- [ ] The tree renders parented agents nested under their parents.
- [ ] A definition edited in the manager persists, reparses cleanly, and triggers the staleness rebuild on next delivery.
- [ ] A model change takes effect on the worker's next session.
- [ ] The manager never throws into the TUI when the daemon is absent.

## Decisions

- [ADR-011](../adr/ADR-011-agent-hierarchy.md) — Persistent child agents are spawn-time state; kill cascades

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-901](../tasks/T-901-tui-tree.md) | Hierarchy in /agents and the spawn flow | Done |
| [T-902](../tasks/T-902-tui-manager.md) | Full-screen agent manager | Done |
| [T-903](../tasks/T-903-tui-editing.md) | Definition and model editing flows | Ready |
