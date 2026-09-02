# T-1405 — Explicit worker-backend selector on the daemon CLI

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-14](../epics/EP-14-dogfooding.md) | [SP-15](../sprints/SP-15-live-accounts.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

The in-process worker backend built in T-1006 becomes operator-reachable: an explicit backend selector in the daemon spawn path and CLI, proven by tests, with the runbook and harness updated so live dogfooding covers both backends for real.

## Read first

- [The in-process backend behind SupervisedWorker](../../../src/worker/lifecycle.ts)
- [The spawn path that selects the backend](../../../src/daemon/main.ts)
- [CLI suite patterns](../../../tests/daemon-cli.test.ts)

## Files this task may change

- `src/daemon/cli.ts`
- `src/daemon/main.ts`
- `tests/daemon-cli.test.ts`
- `docs/dogfooding.md`
- `scripts/dogfood.ts`
- `tests/dogfood.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | The explicit backend selector on the spawn surface, carried through --json output. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | The spawn path honors the CLI-provided selector; the default stays RPC subprocess. |
| [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) | Edited | Selector round-trip through the CLI: explicit rpc, explicit in-process, and the unset default. |
| [`docs/dogfooding.md`](../../../docs/dogfooding.md) | Edited | Created by T-1401; the 'unexposed today' note becomes the selector command, and the scenario's backend coverage becomes real. |
| `scripts/dogfood.ts` (to be created) | Edited | Created by T-1402; the driver gains the in-process leg via the selector. |
| `tests/dogfood.test.ts` (to be created) | Edited | Created by T-1402; the fixture suite covers the in-process leg. |

## Steps

1. Expose the backend selector on the daemon CLI spawn surface: the default stays RPC subprocess, and an unknown value is a refusal, not a fallback.
2. Prove the selector in the CLI suite: explicit rpc, explicit in-process, and the unset default.
3. Replace the runbook's T-1401 'unexposed today' note with the selector command so the scenario's both-backends step is drivable, never skipped-as-success.
4. Extend the driver and its fixture suite with the in-process leg so T-1403's live session exercises both backends.

## Acceptance

- [ ] An operator selects the in-process backend through the shipped CLI alone; the default remains RPC subprocess.
- [ ] The CLI suite proves the selector round-trip and the refusal of unknown values.
- [ ] The runbook and driver cover both backends with no step described as skipped-but-successful.

## Out of scope

- Sandboxing in-process workers — impossible per T-1006; the shield rules keep that visible.
- Abort/allowlist/cleanup enforcement (T-1404).

## Depends on

- T-1402

## Unblocks

- T-1403
