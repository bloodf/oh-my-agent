# EP-04 — Autonomy runtime: workers, rooms, scheduler, quota

**Status:** Done

## Outcome

Peers run as supervised subprocesses, wake on room traffic, fire on cron, park on quota exhaustion, and resume unattended.

## Why this is its own epic

This epic is the product promise. Each part is individually simple and the value is entirely in the wiring: a resume that restarts without delivering, or a wake that ignores subscriptions, looks correct in isolation and fails the user.

## In scope

- RPC worker lifecycle with park, resume, and the delegation invariant.
- Durable room store with per-agent read cursors.
- Cron and one-shot scheduling with Vixie day semantics.
- Account registry, quota park, and armed auto-resume.
- Supervisor tying delivery, parking, and resume together.

## Not in scope

- The TUI surface, which is EP-05.

## Acceptance

- [x] A room post wakes only subscribed, unparked peers.
- [x] A quota block parks every run on the account.
- [x] The armed timer alone restarts the worker and runs a real turn against the backlog.
- [x] A worker delegates through native `task`, proven against a real child.

## Decisions

- [ADR-001](../adr/ADR-001-rpc-subprocess-workers.md) — Peers run as RPC subprocesses, not in-process sessions
- [ADR-006](../adr/ADR-006-account-level-quota-parking.md) — Quota is an account property; subscription accounts auto-resume unattended
- [ADR-007](../adr/ADR-007-native-task-delegation.md) — Peers delegate coding subtasks through native task, never agent_spawn

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-401](../tasks/T-401-worker-lifecycle.md) | RPC worker lifecycle | Done |
| [T-402](../tasks/T-402-room-store.md) | Durable room store | Done |
| [T-403](../tasks/T-403-scheduler.md) | Cron and one-shot scheduler | Done |
| [T-404](../tasks/T-404-account-registry.md) | Account registry and quota state machine | Done |
| [T-405](../tasks/T-405-supervisor.md) | Supervisor: delivery, parking, resume | Done |
