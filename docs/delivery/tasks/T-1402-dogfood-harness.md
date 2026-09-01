# T-1402 — Scripted dogfood scenario driver

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

The runbook's scenario runs as one command: a script drives `omp-agent --json` verbs end-to-end against a live daemon, captures a timestamped session log, and exits non-zero on any failed check.

## Read first

- [CLI verbs](../../../src/daemon/cli.ts)
- [CLI suite patterns](../../../tests/daemon-cli.test.ts)

## Files this task may change

- `scripts/dogfood.ts`
- `tests/dogfood.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `scripts/dogfood.ts` (to be created) | New | The scenario driver: verbs in sequence, JSON results asserted, log capture. |
| `tests/dogfood.test.ts` (to be created) | New | The driver against a fixture daemon with stub accounts — the harness is testable without live credentials. |

## Steps

1. Drive the scenario through the CLI's --json surface only — no socket shortcuts, so the harness tests what an operator runs.
2. Capture a timestamped log of every command, result, and elapsed time; the runbook's triage section reads this format.
3. The suite runs the driver against a booted fixture daemon; live-account runs are the operator's, per the runbook.

## Acceptance

- [ ] One command runs the scenario and writes a session log; any failed check exits non-zero with the step named.
- [ ] The suite proves the driver against a fixture daemon with no live credentials.

## Out of scope

- Nothing deferred.

## Depends on

- T-1401

## Unblocks

- T-1403
