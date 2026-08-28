# T-1003 — Worker pid in status and the registry

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A running worker's OS pid is visible in status and recorded in the agents table, so an operator can find the process.

## Read first

- [Lifecycle](../../../src/worker/lifecycle.ts)
- [Daemon db](../../../src/daemon/db.ts)
- [Protocol](../../../src/shared/protocol.ts)

## Files this task may change

- `src/worker/lifecycle.ts`
- `src/daemon/main.ts`
- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `tests/worker-lifecycle.test.ts`
- `tests/daemon-main.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | `WorkerHandle.pid` from the spawned child (undefined while parked). |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Records the pid in the agents table at spawn/respawn, clears it at stop. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | `AgentStatus.pid?: number` — optional, additive. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Accept the optional field. |
| [`tests/worker-lifecycle.test.ts`](../../../tests/worker-lifecycle.test.ts) | Edited | A real child's pid is reported and dead after stop. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | Status carries the pid of a running peer. |

## Steps

1. Expose the child pid on WorkerHandle (the RPC client's process) — undefined while parked, since a parked peer has no process.
2. Record it in the agents table at spawn and respawn; clear it when the worker stops; the row never shows a dead pid after a clean shutdown.
3. Add the optional field to the wire status and validators; the TUI manager may show it, but that is not required here.

## Acceptance

- [ ] A real child's pid is exposed and the process is gone after stop.
- [ ] Status over the socket carries the pid for a running peer and none for a parked one.
- [ ] The agents row's worker_pid matches the live process while running.

## Out of scope

- Killing by pid from the operator surfaces (kill stays logical, by name).

## Depends on

- T-401

## Unblocks

- Nothing.
