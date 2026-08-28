# EP-02 — Worker isolation: materialization, sandbox, launch gate

**Status:** Done

*Derived from the tasks below.*

## Outcome

A worker starts in a synthetic user root it cannot escape by accident, and an opted-in worker starts under a real OS sandbox or does not start at all.

## Why this is its own epic

This is the epic where an intuitive mental model is wrong and expensive. `workspace:` scopes defaults, not access. Isolation only exists where something enforces it, so the enforcement lives in one place, is compiled from one typed policy, and fails closed.

## In scope

- Synthetic per-worker root owning `HOME` and the four `XDG_*` variables.
- Staged-tree write with move-aside and restore on failure.
- Typed sandbox policy compiling to macOS Seatbelt and Linux `bwrap`.
- Launch gate that probes the adapter and gateway bridge before compiling.

## Not in scope

- Claiming the default configuration is a security boundary.

## Acceptance

- [x] A worker's `agents/` holds only its own definition and its `spawns:` closure.
- [x] A failed swap restores the previous worker directory intact.
- [x] An opted-in peer with no adapter fails to launch rather than running unconfined.
- [x] The seatbelt profile under test is built by the same function production uses.

## Decisions

- [ADR-002](../adr/ADR-002-private-store-materialized-roots.md) — Peer definitions live in a private store and are materialized per worker
- [ADR-005](../adr/ADR-005-sandbox-opt-in-fail-closed.md) — OS sandboxing is opt-in, and opting in fails closed
- [ADR-008](../adr/ADR-008-tests-share-production-builders.md) — Tests exercise production construction, never a parallel copy

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-201](../tasks/T-201-materialization-engine.md) | Synthetic worker root materialization | Done |
| [T-202](../tasks/T-202-sandbox-policy-compiler.md) | Typed sandbox policy compiler | Done |
| [T-203](../tasks/T-203-sandbox-launch-gate.md) | Sandbox launch gate | Done |
| [T-204](../tasks/T-204-shared-policy-builder.md) | Share the worker policy builder with tests | Done |
| [T-205](../tasks/T-205-worker-env-scrub.md) | Worker env scrub | Done |
