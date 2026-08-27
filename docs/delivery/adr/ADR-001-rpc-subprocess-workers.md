# ADR-001 — Peers run as RPC subprocesses, not in-process sessions

**Status:** Accepted

## Context

A peer must survive a crash without taking the daemon with it, carry its own `cwd`, `HOME`, and environment, and be restartable with backoff. An in-process `createAgentSession` shares the daemon's process state, so one peer's fault or env mutation is everyone's.

## Decision

Every peer is a `bun <omp-cli>` child driven over OMP's `RpcClient`. In-process sessions are reserved for tests and daemon-internal tooling.

## Consequences

- Crash isolation and per-peer environment come for free.
- One child process per running peer; parked peers hold only layout and fingerprint.
- `RpcClient.prompt()` returns immediately, so delivery must use `promptAndWait`.
- `RpcClient` keeps its child private, so `sessionId` is the observable identity, not a pid.

## Alternatives considered

| Option | Why rejected |
|---|---|
| In-process sessions for all peers | One faulting peer takes down the daemon and every sibling. |
| Container per peer | Per-OS runtime dependency far beyond an OMP plugin's install story. |

## Evidence

| Claim | Source |
|---|---|
| RPC events are `tool_execution_start` / `tool_execution_end` | [`node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-client.ts:106-117`](../../../node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-client.ts) |
| Worker lifecycle built on RpcClient | [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) |
