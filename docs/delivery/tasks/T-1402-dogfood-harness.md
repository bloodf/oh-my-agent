# T-1402 — Scripted dogfood scenario driver

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Done | [asset-map](../asset-map.md) |

## Goal

Every JSON-capable management verb in the runbook's scenario runs as one command: a script drives `omp-agent --json` end-to-end against a live daemon the operator already started per the runbook, captures a timestamped session log, and exits non-zero on any failed check.

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
| [`scripts/dogfood.ts`](../../../scripts/dogfood.ts) | New | The scenario driver: verbs in sequence, JSON results asserted, per-step timeouts, the poll primitive, resource sampling, log capture with token redaction. |
| [`tests/dogfood.test.ts`](../../../tests/dogfood.test.ts) | New | The driver against a fixture daemon with stub accounts and injected latency — the harness is testable without live credentials. |
| [`.gitignore`](../../../.gitignore) | Edited | The .dogfood/ session-log directory. |

## Steps

1. Drive every JSON-capable management verb through the CLI's --json surface only — no socket shortcuts, so the harness tests what an operator runs. Daemon start and the console URL have no JSON mode: they stay T-1401 runbook preconditions outside the driver's mapping, and the driver's first check asserts the daemon is already reachable rather than starting it.
2. Capture a timestamped session log of every driven command, its JSON result, and elapsed time under `.dogfood/` (gitignored), mode 0600, with any `?token=` material in that JSON-capable driver output redacted as defense-in-depth — the console URL itself is never driven here; it stays a T-1401 manual precondition. The runbook's triage section reads this format.
3. Every step carries a timeout — the CLI's fetch has none, so a wedged live daemon would hang the harness forever — and a poll-until-state primitive replaces fixed sleeps for spawn→ready transitions.
4. The fixture mode injects latency and at least one error frame, so the suite proves resilience rather than the happy path; the suite also asserts the written log contains no token.
5. Sample resources as structured log fields: daemon RSS per phase, per-agent spawn→ready latency, and a phase holding N concurrent agents.

## Acceptance

- [x] One command runs every JSON-capable management verb of the scenario and writes a session log; any failed check exits non-zero with the step named.
- [x] The driver claims no coverage it cannot drive: daemon start, the console URL, the TUI, and the in-process backend selector (T-1405) are outside its mapping and never reported as passed.
- [x] The suite proves the driver against a fixture daemon with no live credentials.
- [x] Per-step timeouts and the poll-until-state primitive are proven against the latency-injecting fixture; no step can hang forever.
- [x] The session log lands in .dogfood/ with mode 0600 and the suite asserts it contains no token material.

Evidence:

| Claim | Anchor |
|---|---|
| Commit d5faa93 drives the bounded JSON-capable dogfood scenario and writes redacted mode-0600 logs | [`scripts/dogfood.ts`](../../../scripts/dogfood.ts) |
| Commit d5faa93 verifies timeouts, polling, injected failures, resource samples, and token-free logs against the fixture daemon | [`tests/dogfood.test.ts`](../../../tests/dogfood.test.ts) |

## Out of scope

- Console/TUI automation; those surfaces are covered by the runbook's manual checklist.
- Daemon start and the console URL — T-1401 preconditions with no JSON mode, not driver steps.
- The worker-backend selector (T-1405); src/daemon/main.ts and src/daemon/cli.ts stay untouched here.

## Depends on

- T-1401

## Unblocks

- T-1403
- T-1404
- T-1405
