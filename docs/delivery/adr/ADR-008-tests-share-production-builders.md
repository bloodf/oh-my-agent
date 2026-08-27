# ADR-008 — Tests exercise production construction, never a parallel copy

**Status:** Accepted

## Context

The seatbelt suite originally rebuilt the sandbox policy inline. Production `gatePeer` could then drift, with wrong `runtimePaths` or dropped `extraRoots`, while every test stayed green.

## Decision

Where a test asserts on a construction production also performs, both call one exported builder. Every regression test is additionally proven non-vacuous: revert the fix, confirm the test fails, restore.

## Consequences

- A single-field policy drift now fails eight seatbelt tests instead of none.
- Non-vacuity probes caught two hollow tests: a delivery assertion that observed only absence, and a room-scoping test with no seeded backlog.
- Proving non-vacuity costs an extra run per regression and is required regardless.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Assert on a hand-built expected policy | The copy and production drift apart silently, which is the failure this prevents. |

## Evidence

| Claim | Source |
|---|---|
| Shared policy builder | [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) |
| Seatbelt suite consumes it | [`tests/seatbelt-wiring.test.ts`](../../../tests/seatbelt-wiring.test.ts) |
| Engineering practice | `ARCHITECTURE.md:174-178` |
