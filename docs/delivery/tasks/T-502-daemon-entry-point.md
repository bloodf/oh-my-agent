# T-502 — Daemon entry point

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

`omp-agent daemon` boots every subsystem and keeps running after its terminal closes.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Broker hosting](../../../src/daemon/boot.ts)
- [Supervisor](../../../src/daemon/supervisor.ts)

## Files this task may change

- `src/daemon/main.ts`
- `src/daemon/socket.ts`
- `package.json`
- `tests/daemon-main.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/daemon/main.ts` (to be created) | New | Composition root. |
| `src/daemon/socket.ts` (to be created) | New | Control socket for the TUI. |
| [`src/daemon/boot.ts`](../../../src/daemon/boot.ts) | Read | `resolveBrokerHosting` already exists. |
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | Read | Started here. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Read | Started here. |
| [`package.json`](../../../package.json) | Edited | Adds the `bin` entry. |

## Steps

1. Compose boot order: resolve broker hosting, start the gateway, open the room store, construct the scheduler, registry, and supervisor.
2. Register peers from the store and arm their schedules.
3. Serve a control socket and write a pidfile under the active agent dir, honoring `PI_CODING_AGENT_DIR`.
4. Detach from the controlling TTY, since surviving a closed terminal is the product's core claim.
5. Shut down in reverse order so a stop does not strand a parked watcher or leave a half-swapped worker dir.

## Acceptance

- [ ] The daemon starts, serves its socket, and answers a status request.
- [ ] It keeps running after its launching terminal exits.
- [ ] A second instance for the same profile refuses to start rather than corrupting shared state.
- [ ] Shutdown closes the gateway, stops workers, and removes the pidfile.
- [ ] Boot honors `PI_CODING_AGENT_DIR` for socket and pidfile placement.

## Out of scope

- TUI rendering, which is T-504.

## Depends on

- T-501

## Unblocks

- T-503
- T-504
