# T-1401 — Dogfooding runbook

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Ready | [asset-map](../asset-map.md) |

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
| `docs/dogfooding.md` (to be created) | New | The runbook: preconditions, scenario, capture protocol, triage rules. |

## Steps

1. Preconditions: which accounts and definitions, a clean daemon state, and the explicit 'this touches real accounts' checklist.
2. The scenario: spawn a parent, deploy a child, run a room exchange, exercise every CLI verb, run both worker backends, kill with cascade.
3. Capture and triage: where the session log lives, and the rule that every finding becomes a generator task or a recorded wont-fix.

## Acceptance

- [ ] A reader can run the full session from the runbook alone; every step names its command or check.

## Out of scope

- Automating the scenario (T-1402).

## Depends on

- Nothing.

## Unblocks

- T-1402
