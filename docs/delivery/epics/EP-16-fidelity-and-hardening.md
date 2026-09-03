# EP-16 — Surface fidelity and protocol hardening

**Status:** Done

*Derived from the tasks below.*

## Outcome

Every surface speaks the protocol with full fidelity - console thread replies land in threads, reaction removals propagate, attribution is enforced by identity - and the daemon's state changes reach the console as typed events.

## Why this is its own epic

The two-model review (sol + m3) found the console advertises thread replies and silently stores them as roots, reaction removals never reach an open console, worker chat attribution is unbound from connection identity, and the security ticket's inject bullet has no test. None of these is visible in the suites because the suites were written to the same mistaken model.

## In scope

- The tasks in this epic.

## Not in scope

- Remote mode; EP-12 owns exposure.
- TUI live event subscription; snapshots stay.
- Multi-user auth.
- Persisted read cursors; T-1105 covers unread healing only.

## Acceptance

- [x] A thread reply posted from the console lands in the thread, browser-proven.
- [x] An external chat_unreact updates an open console.
- [x] A worker cannot attribute a message to another peer.
- [x] Agent, schedule, and budget changes reach the console without a manual refresh.
- [x] Kill, inject, logs, and bump are operable from the console with confirmation for subtree kills.
- [x] The CLI gains daemon stop/restart and definition authoring.
- [x] Every acceptance bullet named by the review as unproven has a failing-when-removed test.

## Decisions

- [ADR-014](../adr/ADR-014-attribution-policy.md) — Console speaks as the human; workers speak as themselves; nobody else speaks
- [ADR-015](../adr/ADR-015-typed-daemon-events.md) — Daemon state changes are typed frames; snapshots are for reconnect

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1601](../tasks/T-1601-console-thread-parentage.md) | Console thread replies preserve parentage | Done |
| [T-1602](../tasks/T-1602-reaction-removal-frames.md) | Reaction removal frames | Done |
| [T-1603](../tasks/T-1603-attribution-enforcement.md) | Enforce attribution from connection identity | Done |
| [T-1604](../tasks/T-1604-typed-daemon-events.md) | Typed daemon state events | Done |
| [T-1605](../tasks/T-1605-console-ops-panel.md) | Console operations panel | Done |
| [T-1606](../tasks/T-1606-daemon-lifecycle-verbs.md) | Daemon lifecycle verbs and logs | Done |
| [T-1607](../tasks/T-1607-authoring-parity.md) | Definition authoring parity | Done |
| [T-1608](../tasks/T-1608-mentions-fidelity.md) | Mention fidelity on every surface | Done |
| [T-1609](../tasks/T-1609-identity-negatives.md) | Identity negative-path proofs | Done |
| [T-1610](../tasks/T-1610-unreact-contract.md) | Unreact contract parity | Done |
| [T-1611](../tasks/T-1611-cli-json-everywhere.md) | CLI JSON coverage for every verb | Done |
| [T-1612](../tasks/T-1612-shared-supervisor-contract.md) | Shared supervisor backend contract | Done |
| [T-1613](../tasks/T-1613-build-hygiene-test.md) | Dependency-free console build hygiene | Done |
| [T-1614](../tasks/T-1614-test-timing-hygiene.md) | Deadline-bounded test timing | Done |
| [T-1615](../tasks/T-1615-repaint-focus-stability.md) | Repaint stability: identity-keyed focus, thread-pane restore, and sticky scroll | Done |
| [T-1616](../tasks/T-1616-control-cap-json-rpc.md) | A saturated audit stays readable on the control socket | Done |
