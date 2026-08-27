# ADR-007 — Peers delegate coding subtasks through native task, never agent_spawn

**Status:** Accepted

## Context

A top-level peer coordinates, and in OMP coordination is the native `task` tool. An explicit `tools:` list replaces the default set, so writing one naively strips `task` and leaves the agent unable to delegate at all.

## Decision

`agent_spawn` creates durable peers only. Coding subtasks go through native `task`. Any explicit `tools:` list must re-include `task`, and the invariant is asserted against a real child process, not a mock.

## Consequences

- Subagent isolation and merge-back come from OMP instead of a parallel implementation.
- `classifyAgentSpawn` distinguishes a durable peer from a coding subtask at the call boundary.
- The end-to-end suite asserts a real child dispatched `task` and never `agent_spawn`.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Custom subagent spawner | Reimplements OMP isolation and merge-back, and diverges on every upstream change. |

## Evidence

| Claim | Source |
|---|---|
| Delegation contract | `ARCHITECTURE.md:101-108` |
| Spawn classification | [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) |
| Enforcement pinned against OMP | [`tests/contracts/spawn-policy.contract.test.ts`](../../../tests/contracts/spawn-policy.contract.test.ts) |
