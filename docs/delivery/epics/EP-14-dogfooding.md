# EP-14 — Live-account hardening

**Status:** Ready

*Derived from the tasks below.*

## Outcome

The system runs against the operator's real accounts under a scripted scenario, and every finding becomes a tree entry — the tree stays the single backlog.

## Why this is its own epic

Eight hundred tests prove the machinery; they say nothing about a live account's behavior — a real provider's usage shape, a real broker's long-poll cadence, a TUI at 3am. The gap between 'green suite' and 'trusted daily' is exactly what this epic measures.

## In scope

- A dogfooding runbook and a scripted scenario that drives the CLI verbs end-to-end against a live daemon.
- A session-capture protocol so a finding is reproducible and attributable.
- Live-session safety rails: an abort procedure, an account allowlist with a max-bump ceiling the harness enforces as a refusal, and a cleanup phase that leaves no worker running and no schedule armed (T-1404).

## Not in scope

- Fixing findings in-place; findings become tasks in the tree, prioritized there.

## Acceptance

- [ ] The scripted scenario exercises every CLI verb and both worker paths against a live daemon.
- [ ] Every finding either becomes a new task in the generator or is closed with a reason recorded in the runbook.
- [ ] The harness refuses an account outside the allowlist or a bump above the ceiling, and an abort during any phase leaves no running worker and no armed schedule.

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1401](../tasks/T-1401-dogfood-runbook.md) | Dogfooding runbook | Ready |
| [T-1402](../tasks/T-1402-dogfood-harness.md) | Scripted dogfood scenario driver | Blocked |
| [T-1403](../tasks/T-1403-first-live-session.md) | First live session and triage | Blocked |
| [T-1404](../tasks/T-1404-live-session-safety-rails.md) | Live-session safety rails | Blocked |
| [T-1405](../tasks/T-1405-daemon-backend-selector.md) | Explicit worker-backend selector on the daemon CLI | Blocked |
