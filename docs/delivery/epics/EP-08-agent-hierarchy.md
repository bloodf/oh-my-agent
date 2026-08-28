# EP-08 — Agent hierarchy and authoring

**Status:** Ready

*Derived from the tasks below.*

## Outcome

A peer can deploy persistent child peers under itself — a CEO standing up a CTO and staff — with the tree visible to the operator, children surviving restarts, and creation guided by shipped skills instead of code archaeology.

## Why this is its own epic

The native `task` tool is a temporary subagent: its transcript folds into the parent run and it is gone. Standing teams need durable peers with their own lifecycle, rooms, and budget, parented so the operator can see who deployed whom — and without a kill cascade, a dead parent leaves children spending and messaging forever with no owner.

## In scope

- Protocol additions: `agent_create`, `definition_get`, `definition_update`, a `parent` field on `agent_spawn`, and `parent`/`children` on status (additive, no version bump).
- Daemon hierarchy state: `agents.parent`, cycle rejection, kill cascade, orphan refusal at boot, family channel, account-only inheritance.
- Toolbelt authoring tools with child-vs-task selection guidance.
- Shipped skills for agent and subagent authoring, discovered by OMP and materialized into workers.

## Not in scope

- Enforcing anything off parentage — it is cooperative metadata until the socket has connection identity (ADR-011).
- Any change to native `task` recursion or spawn policy.

## Acceptance

- [ ] A worker creates and spawns a child through the toolbelt, and the child appears under it in status output and the TUI.
- [ ] Killing a parent stops its subtree; a boot refuses to wake an agent whose parent is gone.
- [ ] A cycle (`A` under `B` under `A`) is rejected at spawn.
- [ ] A child never inherits its parent's rooms or budget by default.
- [ ] The shipped skills are discovered by OMP's real `loadSkills` and a worker selecting them receives them in its materialized root.

## Decisions

- [ADR-011](../adr/ADR-011-agent-hierarchy.md) — Persistent child agents are spawn-time state; kill cascades
- [ADR-007](../adr/ADR-007-native-task-delegation.md) — Peers delegate coding subtasks through native task, never agent_spawn

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-801](../tasks/T-801-hierarchy-protocol.md) | Hierarchy and authoring protocol | Ready |
| [T-802](../tasks/T-802-daemon-hierarchy.md) | Daemon hierarchy: parented spawns, cascades, orphan refusal | Ready |
| [T-803](../tasks/T-803-toolbelt-authoring.md) | Toolbelt: create and parent agents | Ready |
| [T-804](../tasks/T-804-authoring-skills.md) | Shipped skills for agent and subagent authoring | Done |
