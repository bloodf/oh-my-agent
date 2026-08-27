# ADR-002 — Peer definitions live in a private store and are materialized per worker

**Status:** Accepted

## Context

`~/.omp/agent/agents/` is a global OMP discovery root: anything parked there appears in the `/agents` hub of every unrelated OMP session. Worse, `discoverAgents()` consults generic native config roots as well as `getAgentDir()`, so `PI_CODING_AGENT_DIR` alone does not fully reroot discovery.

## Decision

Definitions live in plugin-private paths. At spawn the daemon materializes a synthetic user root per worker under `workers/<agent>/home/`, owning `HOME` and all four `XDG_*` variables, whose `agents/` contains only that worker's own definition plus its `spawns:` closure.

## Consequences

- A peer definition never leaks into unrelated OMP sessions.
- A worker can only discover the agents its `spawns:` closure names.
- Writes go to a staged tree and swap by move-aside/restore, never `rm` before `rename`.
- Definitions are fingerprinted; a changed definition rebuilds the dir rather than mutating under a live process.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Write into the global agent root | Pollutes every unrelated OMP session's agent hub. |
| Set PI_CODING_AGENT_DIR only | Generic native config roots are still consulted, so discovery is not fully rerooted. |

## Evidence

| Claim | Source |
|---|---|
| Materialization engine | [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) |
| Discovery precedence pinned against real OMP | [`tests/contracts/discovery.contract.test.ts`](../../../tests/contracts/discovery.contract.test.ts) |
