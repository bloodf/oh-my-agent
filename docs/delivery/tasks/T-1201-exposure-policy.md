# T-1201 — Remote-mode surface and bind refusal

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Ready | [asset-map](../asset-map.md) |

## Goal

One explicit remote-mode switch exists; a non-loopback bind without it is refused with the reason on stderr, and the loopback default is byte-identical to today.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [ADR-012: remote exposure](../../../docs/delivery/adr/ADR-012-remote-exposure.md)
- [Console API and its loopback stance](../../../src/daemon/console-api.ts)
- [Control socket](../../../src/daemon/socket.ts)

## Files this task may change

- `src/daemon/main.ts`
- `src/daemon/console-api.ts`
- `src/daemon/socket.ts`
- `tests/remote-exposure.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Parses the remote-mode flag/config at boot; the refusal runs before any listener opens. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | The loopback-only comment becomes an enforced gate: non-loopback requires remote mode plus the operator token on every request. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | The same gate for the control socket's bind and per-connection identity. |
| `tests/remote-exposure.test.ts` (to be created) | New | Refusal without the flag; token required in remote mode; loopback flows unchanged. |

## Steps

1. Add the surface: one flag or config key, parsed at boot, off by default. A non-loopback bind without it exits before any listener opens, naming the flag on stderr.
2. Thread remote mode into the console API and the control socket: in remote mode every request and connection presents the operator token (T-1004's layer).
3. Tests: refusal without the flag, token required in remote mode, and every existing suite passing unchanged on the loopback default.

## Acceptance

- [ ] A non-loopback bind without the flag exits before any listener opens, with the reason on stderr.
- [ ] Remote mode without the operator token is refused on both the console and the control socket.
- [ ] The loopback default keeps every existing suite green unchanged.

## Out of scope

- TLS itself (T-1202, via proxy per ADR-012) and the console's login UX (T-1203).

## Depends on

- T-1004

## Unblocks

- T-1202
- T-1204
- T-1205
