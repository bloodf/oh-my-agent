# T-704 — Identify and fix the intermittent test failure

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-07](../epics/EP-07-release-readiness.md) | [SP-08](../sprints/SP-08-release-readiness.md) | Done | [asset-map](../asset-map.md) |

## Goal

The suite is deterministic: the failure seen once in twelve local runs is named, reproduced, and fixed.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Test harness](../../../tests/harness.test.ts)

## Files this task may change

- `tests/`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/`](../../../tests/) | Edited | Whichever suite the flake lands in; unknown until caught with a full log. |

## Steps

1. Catch it with the log kept: `bun test 2>&1 | tee run.log` in a loop, or let CI capture it — the one observed failure (412 total, 1 fail) printed no test name before the shell moved on.
2. Bias toward the timing-sensitive suites under load: gateway long-polls, scheduler timers, supervisor wake delivery. The single red run happened while the machine was under heavy parallel load; ten unloaded runs were green.
3. Once named, fix the test's synchronization rather than widening a timeout — a longer timeout is a slower flake, not a smaller one.

## Acceptance

- [x] The failing test is identified from a captured full log.
- [x] Its fix is proven non-vacuous per the working rules.
- [x] Ten consecutive full-suite runs pass with the machine under normal load.

Evidence:

| Claim | Anchor |
|---|---|
| Root cause: OMP's legacy-pi compat installs a process-global Bun.plugin onResolve hook that memo-corrupted import.meta.resolve for @oh-my-pi/* — deterministic ordering, not a race | [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) |
| Ten consecutive full-suite runs green; resolver shared by both spawn paths and the tests (ADR-008) | [`tests/skills.test.ts`](../../../tests/skills.test.ts) |

## Out of scope

- Deleting or skipping the flaky test. A skipped test is an admission the behavior is unspecified.

## Depends on

- Nothing.

## Unblocks

- Nothing.
