# EP-00 — Foundations and OMP contracts

**Status:** Done

## Outcome

The plugin package exists, and the three assumptions everything else rests on are pinned by tests that run against the real OMP build rather than a mock.

## Why this is its own epic

Every later epic depends on how OMP actually behaves: where it discovers agents, what the broker wire protocol is, and how spawn policy is enforced. A wrong guess here is not a local bug, it is a rewrite. Contract suites turn each assumption into a failing test the moment an OMP upgrade changes it.

## In scope

- Package manifest exposing the extension through `omp.extensions`.
- Test harness with a fake broker and disposable agent directories.
- Contract suites for discovery precedence, broker protocol, and spawn policy.

## Not in scope

- Any daemon behavior; contracts only describe OMP.

## Acceptance

- [x] `bun test` runs the contract suites against the installed OMP packages.
- [x] Discovery precedence is asserted, including that the plugin's private store is not a discovery root.
- [x] Broker snapshot, long-poll, block, and refresh shapes are pinned against `startAuthBroker`.
- [x] `task.disabledAgents` preflight and `spawns:` enforcement are pinned.

## Decisions

- [ADR-002](../adr/ADR-002-private-store-materialized-roots.md) — Peer definitions live in a private store and are materialized per worker
- [ADR-007](../adr/ADR-007-native-task-delegation.md) — Peers delegate coding subtasks through native task, never agent_spawn

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-001](../tasks/T-001-package-scaffold.md) | Plugin package scaffold | Done |
| [T-002](../tasks/T-002-test-harness.md) | Contract-test harness | Done |
| [T-003](../tasks/T-003-discovery-contract.md) | Agent discovery precedence contract | Done |
| [T-004](../tasks/T-004-broker-contract.md) | Auth broker wire-protocol contract | Done |
| [T-005](../tasks/T-005-spawn-policy-contract.md) | Spawn policy enforcement contract | Done |
