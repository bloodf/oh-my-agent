# T-1401 — Dogfooding runbook

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Done | [asset-map](../asset-map.md) |

## Goal

A written runbook takes the operator from zero to a live dogfood session: account checklist, the scenario, what to capture, and how a finding becomes a task.

## Read first

- [README](../../../README.md)
- [CLI verbs the scenario drives](../../../src/daemon/cli.ts)
- [Console guide](../../../docs/web-console.md)

## Files this task may change

- `docs/dogfooding.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`docs/dogfooding.md`](../../../docs/dogfooding.md) | New | The runbook: preconditions, scenario, capture protocol, triage rules. |

## Steps

1. Preconditions: which accounts and definitions, a clean daemon state, starting the daemon and capturing the console URL by hand — neither has a JSON mode, so both sit before the scripted scenario as T-1401 preconditions — and the explicit 'this touches real accounts' checklist.
2. The scenario: spawn a parent, deploy a child, run a room exchange, exercise every CLI verb over the shipped RPC worker backend, kill with cascade — plus a manual console+TUI checklist: open the console URL, watch the room live during the run, confirm TUI state transitions. The runbook states plainly that the in-process backend is not selectable through the shipped CLI today; its coverage arrives with T-1405 and is never recorded as exercised before then.
3. Capture and triage: where the session log lives, and the rule that every finding becomes a generator task or a recorded wont-fix. On any incident the runbook directs the operator to stop the session and preserve the log and daemon state as evidence — enforced abort, allowlist, and cleanup are T-1404's, not described here.

## Acceptance

- [x] T-1402's driver implements every JSON-capable runbook step 1:1; daemon start, the console URL, the TUI checklist, and the in-process backend note are marked manual (or deferred to T-1405) with a check to record — no step is described as automated or covered when it is not.

Evidence:

| Claim | Anchor |
|---|---|
| Commit a42075f documents dogfood preconditions, JSON-capable scenario steps, manual checks, capture, and triage | [`docs/dogfooding.md`](../../../docs/dogfooding.md) |

## Out of scope

- Automating the scenario (T-1402).
- Abort/allowlist/cleanup enforcement (T-1404); the runbook may say stop and preserve evidence, never implement cleanup.
- A CLI worker-backend selector (T-1405).

## Depends on

- Nothing.

## Unblocks

- T-1402
