# T-1618 — A budget bump must be a positive number

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

The metered ceiling a bump installs is validated as strictly positive at both the protocol boundary and the supervisor, because the usage poller divides spend by it.

## Read first

- [The division that makes this load-bearing](../../../src/daemon/main.ts)
- [Bump params](../../../src/shared/protocol-schemas.ts)
- [The supervisor entry point](../../../src/daemon/supervisor.ts)

## Files this task may change

- `src/shared/protocol-schemas.ts`
- `src/daemon/supervisor.ts`
- `tests/supervisor.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | A positive-number check for budgetUsd on bump, alongside the existing one on autonomy.budgetUsd. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | bumpBudget refuses a non-positive ceiling before mutating anything, since the method is reachable in-process as well as over the protocol. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | Zero and negative bumps are refused, and the original ceiling is what the 80% warning still names. |

## Steps

1. Reproduce through the CLI: `bump <account> -5` was accepted and installed a negative ceiling.
2. Add the positive check to the bump params and to the supervisor, before any state changes.
3. Assert both directions of the arithmetic: zero divides to Infinity and parks immediately, negative clamps to zero and never warns or parks at all.

## Acceptance

- [x] A zero or negative bump is refused at the protocol boundary and by the supervisor.
- [x] A refused bump leaves the configured ceiling untouched.
- [x] A positive bump still raises the ceiling and resumes parked peers.

Evidence:

| Claim | Anchor |
|---|---|
| budgetUsd must be a positive number on bump | [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) |
| The supervisor refuses before mutating | [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) |
| Zero and negative bumps are refused and the ceiling survives | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |

## Out of scope

- Changing the 80% warn or 100% park thresholds themselves.

## Depends on

- Nothing.

## Unblocks

- Nothing.
