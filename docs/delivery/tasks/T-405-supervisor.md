# T-405 — Supervisor: delivery, parking, resume

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-04](../epics/EP-04-autonomy-runtime.md) | [SP-04](../sprints/SP-04-autonomy.md) | Done | [asset-map](../asset-map.md) |

## Goal

A room post reaches the right peers, and an armed timer alone restarts a parked worker and runs its backlog.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Worker lifecycle](../../../src/worker/lifecycle.ts)
- [Room store](../../../src/rooms/store.ts)

## Files this task may change

- `src/daemon/supervisor.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | New | Ties runtime pieces together. |
| [`src/daemon/account-registry.ts`](../../../src/daemon/account-registry.ts) | Read | Park and resume signals. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | New | 13 tests. |
| [`tests/end-to-end.test.ts`](../../../tests/end-to-end.test.ts) | New | 6 tests. |

## Steps

1. Own `post()` as the production trigger, so delivery is not something only a test can drive.
2. Filter by tracked subscription and skip parked peers, because `deliver` drains a peer's entire backlog and an unrelated room would otherwise flush it.
3. Skip the author, so a peer's own post does not wake it.
4. On resume, call `resume()` then `deliver()`: a restarted worker with a full backlog would otherwise idle, defeating unattended progress.
5. Expose `settled()` so callers can await queued park and resume work.

## Acceptance

- [x] A post wakes only subscribed, unparked peers.
- [x] A post in an unsubscribed room leaves the peer's backlog untouched.
- [x] The armed timer alone restarts the worker and its child dispatches a real tool call.
- [x] A parked peer is skipped rather than burning a turn that would fail.
- [x] 19 tests pass across the supervisor and end-to-end suites.

Evidence:

| Claim | Anchor |
|---|---|
| Supervisor suite, 13 tests | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |
| End-to-end suite, 6 tests | [`tests/end-to-end.test.ts`](../../../tests/end-to-end.test.ts) |
| Commits | `5bae1e0, ef1cbe0` |

## Out of scope

- Nothing deferred.

## Depends on

- T-401
- T-402
- T-404

## Unblocks

- Nothing.
