# ADR-005 — OS sandboxing is opt-in, and opting in fails closed

**Status:** Accepted

## Context

`workspace:` scopes defaults, not access: it does not stop a worker reading `~/.ssh`. Only an OS sandbox is a real filesystem boundary, but it constrains tooling and needs per-OS setup, so defaulting it on breaks ordinary use.

## Decision

Layers 2 and 3 are on by default; the OS sandbox is opt-in per peer. Once a peer opts in, `startWorker` gates it: probe the adapter and the gateway bridge, and refuse to launch if either is unavailable. No caller may supply a prebuilt plan.

## Consequences

- An opted-in agent never silently downgrades to an unsandboxed launch.
- Linux `bwrap --share-net` cannot enforce port-level loopback, so it requires explicit `unrestricted-host-network` acceptance.
- `/agents` shows a shield only for sandboxed agents, so the real guarantee is visible.
- The gateway endpoint is validated at materialization: implicit ports and non-loopback hosts are rejected rather than compiling a profile the worker cannot dial.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Sandbox on by default | Contradicts the architecture's layer-1 opt-in and breaks tooling on machines with no adapter. |
| Warn and continue when the adapter is missing | An agent the user believes is sandboxed would run unconfined. |

## Evidence

| Claim | Source |
|---|---|
| Layer 1 is opt-in | `ARCHITECTURE.md:141` |
| Launch gate probes then compiles | [`src/worker/launch-gate.ts`](../../../src/worker/launch-gate.ts) |
| Policy is built once and shared with tests | [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) |
