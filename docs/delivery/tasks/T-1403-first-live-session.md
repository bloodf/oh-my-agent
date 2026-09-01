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
| `docs/dogfooding.md` (to be created) | Edited | The session record: date, accounts, outcome per step, finding dispositions. |
| [`scripts/gen-delivery-docs.py`](../../../scripts/gen-delivery-docs.py) | Edited | Each accepted finding becomes a task entry with the usual contract. |

## Steps

1. Pick this up WHEN the operator's live accounts are ready and the runbook plus harness are Done.
2. Run the harness against the live daemon and capture the log.
3. Triage within the session: every finding becomes a generator task (Ready or Blocked per its deps) or a wont-fix with the reason in the runbook.

## Acceptance

- [ ] The session record is in the runbook with a disposition for every finding.
- [ ] The generator regenerates clean with the finding tasks added.

## Out of scope

- Nothing deferred.

## Depends on

- T-1402

## Unblocks

- Nothing.
