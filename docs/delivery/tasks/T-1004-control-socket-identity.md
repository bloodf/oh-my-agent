# T-1004 — Connection identity on the control socket

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Done | [asset-map](../asset-map.md) |

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
- `tests/fixtures/control-client.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Per-connection bearer: workers get their scoped token, the TUI/console the operator token. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Issues and stores the credentials; the pidfile dir already protects the socket path. |
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | Presents the worker's token from its env. |
| [`src/extension/widget.ts`](../../../src/extension/widget.ts) | Edited | Reads the operator token from the state file. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | The auth failure shape. |
| [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) | New | Unauthenticated calls refused; a worker's kill of a peer it does not own is refused. |
| [`tests/fixtures/control-client.ts`](../../../tests/fixtures/control-client.ts) | New | Shared token-reading control client every socket-calling harness uses (ADR-008). |

## Steps

1. Pick this up WHEN: the console or socket binds beyond loopback, or parentage needs to be authoritative (ADR-011's stated precondition).
2. Issue per-identity bearer tokens at boot (worker tokens exist at the gateway; this is the control socket's own layer).
3. Enforce: unauthenticated → unauthorized; a worker's parent claims must equal its identity; kill/bump/inject are operator-only.
4. Keep loopback trust as the documented default for the local single-operator case; identity is the hardening layer, not a tax on it.

## Acceptance

- [x] An unauthenticated socket call is refused with the declared error shape.
- [x] A worker token cannot kill or inject into a peer it does not own.
- [x] The operator token path keeps today's TUI/console flows working unchanged.

Evidence:

| Claim | Anchor |
|---|---|
| Bearer identity on the socket with per-worker revocation | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| Identity suite plus every harness presenting its token | [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) |

## Out of scope

- Replacing loopback as the default trust model; this task exists so the trigger is named, not to add ceremony today.

## Depends on

- T-502

## Unblocks

- T-1201
