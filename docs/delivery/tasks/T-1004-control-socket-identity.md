# T-1004 — Connection identity on the control socket

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Planned | [asset-map](../asset-map.md) |

## Goal

When the control socket ever needs to distinguish callers, each client presents a credential and the daemon can enforce per-identity rules — including making agent hierarchy authoritative instead of cooperative.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)
- [Socket server](../../../src/daemon/socket.ts)

## Files this task may change

- `src/daemon/socket.ts`
- `src/daemon/main.ts`
- `src/worker/toolbelt.ts`
- `src/extension/widget.ts`
- `src/shared/protocol.ts`
- `tests/socket-identity.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Per-connection bearer: workers get their scoped token, the TUI/console the operator token. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Issues and stores the credentials; the pidfile dir already protects the socket path. |
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | Presents the worker's token from its env. |
| [`src/extension/widget.ts`](../../../src/extension/widget.ts) | Edited | Reads the operator token from the state file. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | The auth failure shape. |
| `tests/socket-identity.test.ts` (to be created) | New | Unauthenticated calls refused; a worker's kill of a peer it does not own is refused. |

## Steps

1. Pick this up WHEN: the console or socket binds beyond loopback, or parentage needs to be authoritative (ADR-011's stated precondition).
2. Issue per-identity bearer tokens at boot (worker tokens exist at the gateway; this is the control socket's own layer).
3. Enforce: unauthenticated → unauthorized; a worker's parent claims must equal its identity; kill/bump/inject are operator-only.
4. Keep loopback trust as the documented default for the local single-operator case; identity is the hardening layer, not a tax on it.

## Acceptance

- [ ] An unauthenticated socket call is refused with the declared error shape.
- [ ] A worker token cannot kill or inject into a peer it does not own.
- [ ] The operator token path keeps today's TUI/console flows working unchanged.

## Out of scope

- Replacing loopback as the default trust model; this task exists so the trigger is named, not to add ceremony today.

## Depends on

- T-502

## Unblocks

- Nothing.
