# T-508 — Daemon persistence and orphan sweep

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

Agents, runs, and schedules survive a daemon restart, and worker directories left by a crash are swept at boot.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Daemon entry point](../../../docs/delivery/tasks/T-502-daemon-entry-point.md)
- [Room store](../../../src/rooms/store.ts)

## Files this task may change

- `src/daemon/db.ts`
- `src/daemon/main.ts`
- `tests/daemon-persistence.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/daemon/db.ts` (to be created) | New | `agents`, `runs`, `schedules` tables and their accessors. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Opens the database and runs the sweep during boot. |
| `tests/daemon-persistence.test.ts` (to be created) | New | Restart survival, run records, sweep. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | The existing SQLite conventions to follow, not a second style. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Read | Owns the `workers/` layout the sweep cleans up. |

## Steps

1. Add `agents`, `runs`, and `schedules` tables, following the room store's existing SQLite conventions rather than introducing a second persistence style in the same process.
2. Write one run record per delivered turn: which peer, which trigger, what outcome. Without it a restart erases the only evidence of what the system did while nobody was watching, which is precisely the period this product exists to cover.
3. Restore registered agents and armed schedules from the database at boot, so an unattended restart resumes rather than starting empty.
4. Sweep orphaned `workers/` materialized directories at startup by comparing them against the persisted registry. This is why the task follows T-502: the sweep needs a registry that outlives the crash, and a sweep with no registry either deletes live state or nothing.
5. Make the sweep conservative and loud: report what it removed. A silent deleter of directories is not something to debug at 3am.

## Acceptance

- [ ] Agents, runs, and schedules reload after a daemon restart.
- [ ] Every delivered turn leaves exactly one run record naming its trigger and outcome.
- [ ] A `workers/` directory with no registry entry is removed at boot and reported.
- [ ] A `workers/` directory that does have a registry entry is left alone.
- [ ] The sweep is proven non-vacuous: with the sweep reverted, the orphan test fails.

## Out of scope

- Transcript storage; §10 resolves that as OMP's own JSONL plus a cursor, not a duplicate message store.
- Room, message, and subscription tables, which T-402 owns.

## Depends on

- T-502

## Unblocks

- Nothing.
