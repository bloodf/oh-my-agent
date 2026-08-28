# T-802 — Daemon hierarchy: parented spawns, cascades, orphan refusal

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-08](../epics/EP-08-agent-hierarchy.md) | [SP-09](../sprints/SP-09-agent-hierarchy.md) | Done | [asset-map](../asset-map.md) |

## Goal

The daemon records who deployed whom, enforces the hierarchy rules, and never leaves an orphan running.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)
- [Daemon entry point](../../../src/daemon/main.ts)
- [Persistence](../../../src/daemon/db.ts)

## Files this task may change

- `src/daemon/db.ts`
- `src/daemon/main.ts`
- `src/daemon/socket.ts`
- `tests/daemon-hierarchy.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/db.ts`](../../../src/daemon/db.ts) | Edited | `agents.parent` column (recreate per the pre-release precedent), tree reads, orphan listing. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Spawn with parent: cycle rejection, account inheritance, family channel; kill cascades with an explicit keep-children reparent; boot refuses orphaned agents and reports them. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Serves T-801's new methods against the store and registry; status carries parent/children. |
| [`tests/daemon-hierarchy.test.ts`](../../../tests/daemon-hierarchy.test.ts) | New | Tree, cascade, orphan, and cycle cases over the real socket. |

## Steps

1. Persist `parent` on the agents table at spawn and expose tree reads (children of, ancestors of).
2. On `agent_spawn` with `parent`: reject when the parent is unknown, when the walk from parent reaches the child (cycle), or when the parent is stopped; inherit the parent's account; create and join `#<parent>-team` in place of the parent's rooms.
3. `agent_create` delegates to the peer-store write path (parse-validated, atomic); `definition_get`/`definition_update` read and rewrite definitions through the store, and an update that changes policy is answered by T-505's rebuild on next delivery — assert that handoff.
4. `kill` stops the whole subtree by default; `keep_children: true` reparents children to root. Boot: an agent whose parent is absent from the registry is not started and is flagged `orphaned` in status.

## Acceptance

- [x] A spawned child persists its parent across a daemon restart.
- [x] A cycle is rejected at spawn with the path named.
- [x] Killing a parent stops its children; keep-children reparents them to root.
- [x] An agent whose parent is gone is not woken at boot and is flagged orphaned.
- [x] A child inherits the parent's account and joins the family channel, not the parent's rooms.
- [x] A definition update that changes policy is followed by a rebuild on next delivery (T-505's path, exercised end to end).

Evidence:

| Claim | Anchor |
|---|---|
| Hierarchy state and rules in the daemon | [`src/daemon/main.ts`](../../../src/daemon/main.ts) |
| Hierarchy suite, 30 tests with 18 revert-probes | [`tests/daemon-hierarchy.test.ts`](../../../tests/daemon-hierarchy.test.ts) |

## Out of scope

- The toolbelt caller side (T-803) and the TUI tree (EP-09).

## Depends on

- T-801

## Unblocks

- T-803
- T-901
