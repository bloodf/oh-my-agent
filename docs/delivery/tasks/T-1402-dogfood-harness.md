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
- `.gitignore`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `scripts/dogfood.ts` (to be created) | New | The scenario driver: verbs in sequence, JSON results asserted, per-step timeouts, the poll primitive, resource sampling, log capture with token redaction. |
| `tests/dogfood.test.ts` (to be created) | New | The driver against a fixture daemon with stub accounts and injected latency — the harness is testable without live credentials. |
| [`.gitignore`](../../../.gitignore) | Edited | The .dogfood/ session-log directory. |

## Steps

1. Drive the scenario through the CLI's --json surface only — no socket shortcuts, so the harness tests what an operator runs.
2. Capture a timestamped session log of every command, result, and elapsed time under `.dogfood/` (gitignored), mode 0600, with any `?token=` material redacted — the console verb's output embeds the bearer token. The runbook's triage section reads this format.
3. Every step carries a timeout — the CLI's fetch has none, so a wedged live daemon would hang the harness forever — and a poll-until-state primitive replaces fixed sleeps for spawn→ready transitions.
4. The fixture mode injects latency and at least one error frame, so the suite proves resilience rather than the happy path; the suite also asserts the written log contains no token.
5. Sample resources as structured log fields: daemon RSS per phase, per-agent spawn→ready latency, and a phase holding N concurrent agents.

## Acceptance

- [ ] One command runs the scenario and writes a session log; any failed check exits non-zero with the step named.
- [ ] The suite proves the driver against a fixture daemon with no live credentials.
- [ ] Per-step timeouts and the poll-until-state primitive are proven against the latency-injecting fixture; no step can hang forever.
- [ ] The session log lands in .dogfood/ with mode 0600 and the suite asserts it contains no token material.

## Out of scope

- Console/TUI automation; those surfaces are covered by the runbook's manual checklist.

## Depends on

- T-1401

## Unblocks

- T-1403
- T-1404
