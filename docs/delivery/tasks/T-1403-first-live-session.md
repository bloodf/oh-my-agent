# T-1403 — First live session and triage

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

The first live dogfood session runs end-to-end and every finding lands in the tree — the epic's acceptance, executed.

## Read first

- [CLI verbs the harness drives](../../../src/daemon/cli.ts)
- [Worker backends the scenario exercises](../../../src/worker/lifecycle.ts)

## Files this task may change

- `docs/dogfooding.md`
- `scripts/gen-delivery-docs.py`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`docs/dogfooding.md`](../../../docs/dogfooding.md) | Edited | Created by T-1401; the session record lands here: date, accounts, per-step pass/finding/skipped, finding dispositions. |
| [`scripts/gen-delivery-docs.py`](../../../scripts/gen-delivery-docs.py) | Edited | Each accepted finding becomes a task entry with the usual contract. |

## Steps

1. Pick this up WHEN the operator's live accounts are ready and the runbook, harness, backend selector, and safety rails are Done.
2. Run the harness against the live daemon and capture the log.
3. Triage within the session: every finding becomes a generator task (Ready or Blocked per its deps) or a wont-fix with the reason in the runbook.

## Acceptance

- [ ] The session record enumerates every runbook step as pass/finding/skipped — 'no findings' is a positive per-step claim, not silence.
- [ ] The session runs inside a timebox; hitting it means stop-and-triage, not overrun.
- [ ] Every wont-fix quotes the session log line as evidence.
- [ ] The generator regenerates clean with the finding tasks added.

## Out of scope

- Nothing deferred.

## Depends on

- T-1402
- T-1404
- T-1405

## Unblocks

- Nothing.
