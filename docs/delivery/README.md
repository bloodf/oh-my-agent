# oh-my-agent delivery tree

Every unit of work on this project, as a file you can open and act on without reading the whole history. Written so a fresh session can pick up any single task cold.

## Start here

1. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — what the system is and why. Read it as a design specification: every section is marked `[Implemented]`, `[Partial]`, or `[Planned]`, and where the two documents disagree this tree wins.
2. [`adr/`](adr/) — the decisions, each with the alternatives that lost and the evidence behind it.
3. The epic you are working in, then its task file.
4. [`asset-map.md`](asset-map.md) — which task owns a given source file.

## Current state

**54 of 59 tasks Done.** Suite state is not restated here, because a pasted count rots the day after it is pasted: CI runs `tsc --noEmit` and `bun test` on every push, and `bun test` locally gives you the same answer.

Every runtime subsystem is built and under test: workers, isolation, credentials, rooms, scheduling, and quota handling. Two things keep that from meaning finished.

First, there is no operator surface. The extension entry point is an empty factory and there is no daemon binary, so nothing here can currently be launched or looked at by a human (EP-05).

Second, the release surface is one push old: the CI workflow, lint configuration, and root README now exist (EP-07), but the workflow has never run on a runner — T-701 stays In progress until a push proves it.

The credential gateway is now verified at its consumer as well as its wire: a stock `RemoteAuthCredentialStore` drives it in [T-303](tasks/T-303-client-integration.md), which found and fixed a real shutdown defect — a daemon would hang on exit while any worker was parked on a long-poll.

## Unit contract

Every task file carries the same eight sections in the same order: Goal, Read first, Files this task may change, Modules and assets in play, Steps, Acceptance, and then Out of scope, Depends on, Unblocks. Anything else is drift.

`Unblocks` is derived by inverting `Depends on`, so the two halves of an edge cannot disagree. Only `Depends on` is authored.

Epic and sprint status is derived from the tasks inside it, not written down separately, so a container can never claim to be further along than its children.

Task numbers are keyed to their epic: `EP-00` owns `T-0xx`, `EP-05` owns `T-5xx`. The number tells you the parent without opening anything.

## Status values

| Status | Meaning |
|---|---|
| Done | Shipped, tested, and committed. The evidence table names the suite and commit. |
| In progress | Started, and at least one acceptance item is unmet. The gap is named in the epic. |
| Ready | Specified and unblocked. Everything it depends on is Done. |
| Blocked | Waiting on a listed dependency that is not Done. |
| Planned | Specified, but not queued: nothing is waiting on it and nobody has picked it up. |

## Epics

| Epic | Title | Status | Tasks |
|---|---|---|---|
| [EP-00](epics/EP-00-foundations-and-contracts.md) | Foundations and OMP contracts | Done | 6 |
| [EP-01](epics/EP-01-agent-definitions.md) | Peer definitions and private store | Done | 1 |
| [EP-02](epics/EP-02-worker-isolation.md) | Worker isolation: materialization, sandbox, launch gate | Done | 5 |
| [EP-03](epics/EP-03-credential-gateway.md) | Scoped credential gateway | Done | 3 |
| [EP-04](epics/EP-04-autonomy-runtime.md) | Autonomy runtime: workers, rooms, scheduler, quota | Done | 5 |
| [EP-05](epics/EP-05-operator-surface.md) | Operator surface: daemon entry point and TUI | Done | 13 |
| [EP-06](epics/EP-06-web-console.md) | Web console: manage agents and channels from a browser | Done | 5 |
| [EP-07](epics/EP-07-release-readiness.md) | Release readiness: CI, lint, and a README a stranger can act on | Done | 5 |
| [EP-08](epics/EP-08-agent-hierarchy.md) | Agent hierarchy and authoring | Done | 4 |
| [EP-09](epics/EP-09-tui-management.md) | Full TUI management surface | Done | 3 |
| [EP-10](epics/EP-10-production-wiring.md) | Production wiring: serving, usage, and deferred hardening | Planned | 6 |
| [EP-11](epics/EP-11-operator-polish.md) | Operator polish: AAA console and the CLI surface | Ready | 3 |

## Sprints

| Sprint | Title | Status | Theme |
|---|---|---|---|
| [SP-01](sprints/SP-01-contracts-and-parsing.md) | Contracts and parsing | Done | Pin how OMP actually behaves, and turn a peer file into a typed definition. |
| [SP-02](sprints/SP-02-isolation.md) | Isolation | Done | Materialized roots, compiled sandbox policies, and a launch gate that fails closed. |
| [SP-03](sprints/SP-03-credentials.md) | Credentials | Done | A scoped gateway so a worker sees one account, not the vault, verified against the real client that consumes it. |
| [SP-04](sprints/SP-04-autonomy.md) | Autonomy | Done | Workers, rooms, schedules, quota parking, and unattended resume. |
| [SP-05](sprints/SP-05-operator-surface.md) | Operator surface | Done | The parts a human touches: protocol, daemon entry point, persistence, toolbelt, and TUI. |
| [SP-06](sprints/SP-06-conversation-model.md) | Conversation model | Done | Threads, replies, and reactions in the store, then over the wire. |
| [SP-07](sprints/SP-07-web-console.md) | Web console | Done | The browser client and the daemon API behind it. |
| [SP-08](sprints/SP-08-release-readiness.md) | Release readiness | Done | The things that make the repository checkable by a machine and explicable to a stranger: CI, lint, and a README. |
| [SP-09](sprints/SP-09-agent-hierarchy.md) | Agent hierarchy | Done | Persistent child peers under a parent: spawn-time parentage, cascades, and the authoring protocol and skills behind them. |
| [SP-10](sprints/SP-10-tui-management.md) | TUI management | Done | The full-screen manager: browse the tree, edit definitions and models, steer agents without leaving the TUI. |
| [SP-11](sprints/SP-11-production-wiring.md) | Production wiring | Planned | The console served for real, budgets fed by real usage, and the hardening deferred to a named trigger. |
| [SP-12](sprints/SP-12-operator-polish.md) | Operator polish | Ready | AAA visuals and accessibility for the console, and a CLI that needs no TUI at all. |

## Decisions

| ADR status | Meaning |
|---|---|
| Accepted | In force. The code is expected to match it, and a change needs a new ADR. |
| Proposed | Written down and argued, but nothing is built against it yet. |

| ADR | Title | Status |
|---|---|---|
| [ADR-001](adr/ADR-001-rpc-subprocess-workers.md) | Peers run as RPC subprocesses, not in-process sessions | Accepted |
| [ADR-002](adr/ADR-002-private-store-materialized-roots.md) | Peer definitions live in a private store and are materialized per worker | Accepted |
| [ADR-003](adr/ADR-003-scoped-credential-gateway.md) | Workers reach credentials only through a scoped per-worker gateway | Accepted |
| [ADR-004](adr/ADR-004-provider-override-not-custom-model.md) | Worker config emits a provider override, never a custom model entry | Accepted |
| [ADR-005](adr/ADR-005-sandbox-opt-in-fail-closed.md) | OS sandboxing is opt-in, and opting in fails closed | Accepted |
| [ADR-006](adr/ADR-006-account-level-quota-parking.md) | Quota is an account property; subscription accounts auto-resume unattended | Accepted |
| [ADR-007](adr/ADR-007-native-task-delegation.md) | Peers delegate coding subtasks through native task, never agent_spawn | Accepted |
| [ADR-008](adr/ADR-008-tests-share-production-builders.md) | Tests exercise production construction, never a parallel copy | Accepted |
| [ADR-009](adr/ADR-009-threads-and-reactions.md) | Conversation gains threads and reactions; reactions carry agent status | Proposed |
| [ADR-010](adr/ADR-010-mit-license.md) | MIT license, chosen by the repository owner | Accepted |
| [ADR-011](adr/ADR-011-agent-hierarchy.md) | Persistent child agents are spawn-time state; kill cascades | Accepted |

## What to do next

EP-05 opens on two independent fronts: [T-507](tasks/T-507-control-socket-protocol.md) freezes the control-socket protocol and [T-501](tasks/T-501-peer-store.md) loads peer definitions. [T-502](tasks/T-502-daemon-entry-point.md) needs both, and [T-508](tasks/T-508-daemon-persistence.md) needs T-502 because the orphan sweep reads the registry T-502 persists. After that [T-503](tasks/T-503-agent-toolbelt.md), [T-504](tasks/T-504-tui-surface.md), [T-505](tasks/T-505-definition-staleness.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-509](tasks/T-509-wake-filters.md) are independent of each other and can run in parallel.

[T-601](tasks/T-601-conversation-model.md) (the conversation model) depends on nothing in EP-05 and can run alongside any of it. Everything else in EP-06 needs the daemon API from T-502.

EP-07 is unblocked today: [T-701](tasks/T-701-ci-workflow.md), [T-702](tasks/T-702-biome-lint.md), [T-703](tasks/T-703-root-readme-and-metadata.md) have no dependencies and are worth landing early, because CI is what stops the rest of this list from regressing silently.

## Working rules

- **Test-first, and prove the test is not vacuous.** Revert the fix, confirm the test fails, restore. This caught two hollow tests that passed without the code they claimed to cover.
- **Tests call production builders.** A test that rebuilds what production builds will keep passing while production drifts (see [ADR-008](adr/ADR-008-tests-share-production-builders.md)).
- **A task listing more than about six files is too large.** Split it.
- **No phased delivery.** The first shipped version has every documented subsystem working.

## Regenerating

These files are generated. Edit [`gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py) and re-run it; do not hand-edit the output, because hand edits are lost on the next run.

The generator renders into a staging directory, runs every gate against what it just rendered, and only then replaces this tree. A failed gate leaves the previous tree exactly as it was.

```sh
python3 scripts/gen-delivery-docs.py
```
