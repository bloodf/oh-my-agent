# T-502 — Daemon entry point

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Done | [asset-map](../asset-map.md) |

## Goal

`omp-agent daemon` boots every subsystem, serves the control protocol, and keeps running after its terminal closes.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Broker hosting](../../../src/daemon/boot.ts)
- [Supervisor](../../../src/daemon/supervisor.ts)
- [Control protocol](../../../docs/delivery/tasks/T-507-control-socket-protocol.md)
- [ADR-001: RPC subprocess workers](../../../docs/delivery/adr/ADR-001-rpc-subprocess-workers.md)

## Files this task may change

- `src/daemon/main.ts`
- `src/daemon/socket.ts`
- `package.json`
- `tests/daemon-main.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | New | Composition root. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | New | Serves the T-507 protocol over a unix socket. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | New | Boot, socket, single-instance, shutdown. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Read | The method set and version this server implements. |
| [`src/daemon/boot.ts`](../../../src/daemon/boot.ts) | Read | `resolveBrokerHosting` already exists. |
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | Read | Started here. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Read | Started here. |
| [`package.json`](../../../package.json) | Edited | Adds the `bin` entry. |

## Steps

1. Compose boot order: resolve broker hosting, start the gateway, open the room store, construct the scheduler, registry, and supervisor.
2. Register peers from the store and arm their schedules.
3. Serve the T-507 protocol on a unix socket: `status`, `chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`, `rooms_list`, `rooms_post`, `schedules_list`, `schedules_arm`, `kill`, and `bump`. Dispatch through the shared schemas rather than hand-parsing each payload.
4. Write a pidfile beside the socket under the active agent dir, honoring `PI_CODING_AGENT_DIR`.
5. Detach from the controlling TTY, since surviving a closed terminal is the product's core claim.
6. Shut down in reverse order so a stop does not strand a parked watcher or leave a half-swapped worker dir.

## Acceptance

- [x] The daemon starts, serves its socket, and answers a status request.
- [x] It serves every method T-507 declares, or answers method-not-found carrying the protocol version.
- [x] It keeps running after its launching terminal exits.
- [x] A second instance for the same profile refuses to start rather than corrupting shared state.
- [x] Shutdown closes the gateway, stops workers, and removes the pidfile.
- [x] Boot honors `PI_CODING_AGENT_DIR` for socket and pidfile placement.

Evidence:

| Claim | Anchor |
|---|---|
| Daemon suite, 29 tests incl. boot/detach/shutdown | [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) |
| Composition root | [`src/daemon/main.ts`](../../../src/daemon/main.ts) |
| Thirteen-method socket server | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| Commit | `c99c961` |

## Out of scope

- TUI rendering, which is T-504.
- Persisting agents, runs, and schedules, which is T-508.

## Depends on

- T-501
- T-507

## Unblocks

- T-508
- T-503
- T-504
- T-505
- T-506
- T-602
