# T-204 — Share the worker policy builder with tests

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-02](../epics/EP-02-worker-isolation.md) | [SP-02](../sprints/SP-02-isolation.md) | Done | [asset-map](../asset-map.md) |

## Goal

The seatbelt suite asserts on the policy production actually builds.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `src/worker/lifecycle.ts`
- `tests/seatbelt-wiring.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | Exports `buildWorkerPolicy`. |
| [`tests/seatbelt-wiring.test.ts`](../../../tests/seatbelt-wiring.test.ts) | Edited | Consumes it instead of a copy. |

## Steps

1. Extract `buildWorkerPolicy(peer, layout, cwd)` from `gatePeer`.
2. Point the seatbelt suite at it, so a drift in production construction fails the tests instead of hiding behind a duplicate.
3. Prove the coupling: change one policy field and confirm the suite fails.

## Acceptance

- [x] `gatePeer` and the seatbelt suite call the same builder.
- [x] Changing `workerHome` to `cwd` fails 8 of 10 seatbelt tests.
- [x] 10 tests pass with the builder intact.

Evidence:

| Claim | Anchor |
|---|---|
| Seatbelt suite, 10 tests | [`tests/seatbelt-wiring.test.ts`](../../../tests/seatbelt-wiring.test.ts) |
| Commit | `43de7fb` |

## Out of scope

- Nothing deferred.

## Depends on

- T-203

## Unblocks

- Nothing.
