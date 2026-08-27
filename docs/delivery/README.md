# oh-my-agent delivery tree

Every unit of work on this project, as a file you can open and act on without reading the whole history. Written so a fresh session can pick up any single task cold.

## Start here

1. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — what the system is and why. Read it as a design specification: every section is marked `[Implemented]`, `[Partial]`, or `[Planned]`, and where the two documents disagree this tree wins.
2. [`adr/`](adr/) — the decisions, each with the alternatives that lost and the evidence behind it.
3. The epic you are working in, then its task file.
4. [`asset-map.md`](asset-map.md) — which task owns a given source file.

## Current state

**17 of 24 tasks Done.** Test suite: 402 passing across 18 files, `tsc --noEmit` clean.

Every runtime subsystem is built and under test: workers, isolation, credentials, rooms, scheduling, and quota handling. Two things keep that from meaning finished.

First, there is no operator surface. The extension entry point is an empty factory and there is no daemon binary, so nothing here can currently be launched or looked at by a human (EP-05).

Second, one subsystem is verified at its wire and not at its consumer. The credential gateway's suites drive it with `fetch`, so the requester-recovery path is checked as a response shape while the client's reaction to that shape is read from upstream source rather than exercised. [T-303](tasks/T-303-client-integration.md) closes it; until then EP-03 is In progress, not Done.

## Unit contract

Every task file carries the same eight sections in the same order: Goal, Read first, Files this task may change, Modules and assets in play, Steps, Acceptance, and then Out of scope, Depends on, Unblocks. Anything else is drift.

Task numbers are keyed to their epic: `EP-00` owns `T-0xx`, `EP-05` owns `T-5xx`. The number tells you the parent without opening anything.

## Status values

| Status | Meaning |
|---|---|
| Done | Shipped, tested, and committed. The evidence table names the suite and commit. |
| In progress | Substantially built, but at least one acceptance item is unmet. The gap is named in the epic. |
| Ready | Specified and unblocked. Everything it depends on is Done. |
| Blocked | Waiting on a listed dependency. |

## Epics

| Epic | Title | Status | Tasks |
|---|---|---|---|
| [EP-00](epics/EP-00-foundations-and-contracts.md) | Foundations and OMP contracts | Done | 5 |
| [EP-01](epics/EP-01-agent-definitions.md) | Peer definitions and private store | Done | 1 |
| [EP-02](epics/EP-02-worker-isolation.md) | Worker isolation: materialization, sandbox, launch gate | Done | 4 |
| [EP-03](epics/EP-03-credential-gateway.md) | Scoped credential gateway | In progress | 3 |
| [EP-04](epics/EP-04-autonomy-runtime.md) | Autonomy runtime: workers, rooms, scheduler, quota | Done | 5 |
| [EP-05](epics/EP-05-operator-surface.md) | Operator surface: daemon entry point and TUI | Ready | 6 |

## Sprints

| Sprint | Title | Status | Theme |
|---|---|---|---|
| [SP-01](sprints/SP-01-contracts-and-parsing.md) | Contracts and parsing | Done | Pin how OMP actually behaves, and turn a peer file into a typed definition. |
| [SP-02](sprints/SP-02-isolation.md) | Isolation | Done | Materialized roots, compiled sandbox policies, and a launch gate that fails closed. |
| [SP-03](sprints/SP-03-credentials.md) | Credentials | In progress | A scoped gateway so a worker sees one account, not the vault. The wire is verified; the client that consumes it is not (T-303). |
| [SP-04](sprints/SP-04-autonomy.md) | Autonomy | Done | Workers, rooms, schedules, quota parking, and unattended resume. |
| [SP-05](sprints/SP-05-operator-surface.md) | Operator surface | Ready | The parts a human touches: daemon entry point, toolbelt, and TUI. |

## Decisions

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

## What to do next

[T-303](tasks/T-303-client-integration.md) first. It sits in SP-03, needs no new modules, and closes the one place a Done claim outruns its evidence.

Then EP-05 in dependency order: [T-501](tasks/T-501-peer-store.md) then [T-502](tasks/T-502-daemon-entry-point.md). After T-502 the remaining four are independent and can run in parallel.

## Working rules

- **Test-first, and prove the test is not vacuous.** Revert the fix, confirm the test fails, restore. This caught two hollow tests that passed without the code they claimed to cover.
- **Tests call production builders.** A test that rebuilds what production builds will keep passing while production drifts (see [ADR-008](adr/ADR-008-tests-share-production-builders.md)).
- **A task listing more than about six files is too large.** Split it.
- **No phased delivery.** The first shipped version has every documented subsystem working.

## Regenerating

These files are generated. Edit [`gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py) and re-run it; do not hand-edit the output, because hand edits are lost on the next run.

```sh
python3 scripts/gen-delivery-docs.py
```
