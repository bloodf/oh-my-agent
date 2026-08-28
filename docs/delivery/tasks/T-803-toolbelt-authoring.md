# T-803 — Toolbelt: create and parent agents

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-08](../epics/EP-08-agent-hierarchy.md) | [SP-09](../sprints/SP-09-agent-hierarchy.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A worker can author and deploy a child peer without leaving its run, and knows when not to.

## Read first

- [Toolbelt](../../../src/worker/toolbelt.ts)
- [ADR-007: native task delegation](../../../docs/delivery/adr/ADR-007-native-task-delegation.md)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)

## Files this task may change

- `src/worker/toolbelt.ts`
- `tests/toolbelt.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | `agent_create` tool; `agent_spawn` passes `parent` as the calling worker's own name. |
| [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) | Edited | Authoring flows over the real socket. |

## Steps

1. Add the `agent_create` tool: validates fields, calls the socket method, reports the parser's errors verbatim so the model can fix and retry.
2. Teach `agent_spawn` to send `parent` as the worker's own name when it wants a child; the tool description states the cooperative-metadata rule (ADR-011) plainly.
3. Extend the tool descriptions' selection guidance: native `task` for temporary in-run subagents, child peers for durable teammates, `agent_spawn` without parent for top-level peers. The ADR-007 subtask refusal stays.

## Acceptance

- [ ] A worker creates then spawns a child in one run, over the real socket, with the parent recorded.
- [ ] A definition the parser rejects comes back as a tool error carrying the parser's message and no half-written file.
- [ ] The child-vs-task guidance is asserted in the tool descriptions so it cannot silently drift.

## Out of scope

- Connection identity for spawner proof; ADR-011 records why the param is cooperative.

## Depends on

- T-802

## Unblocks

- Nothing.
