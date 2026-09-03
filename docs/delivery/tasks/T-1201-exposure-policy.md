# T-1201 — Remote-mode surface and bind refusal

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Done | [asset-map](../asset-map.md) |

## Goal

One explicit remote-mode switch governs authentication and enforcement only: remote console requests and operator-only control-socket methods require the operator token; scoped worker bearers remain valid only for workerMethods and bind worker identity for T-1204; missing, unregistered, and wrong-authority bearers are refused; any non-loopback bind is refused unconditionally with the reason on stderr; and loopback behavior is unchanged.

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
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Parses the remote-mode flag/config at boot; the unconditional bind refusal runs before any listener opens. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | The loopback-only comment becomes an enforced gate: non-loopback is refused always, and remote mode adds the operator token plus the proxy shared-secret check on every request. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | The same gate for the control socket's bind and per-connection identity; token comparison goes constant-time here too. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | New | Unconditional bind refusal; token required in remote mode; forged forwarded headers gain nothing; loopback flows unchanged. |

## Steps

1. Add the surface: one flag or config key, parsed at boot, off by default; the flag governs authentication and enforcement only. Any non-loopback bind exits before any listener opens, naming the refused address on stderr — flag or no flag.
2. Enumerate every listener at boot — console API, control socket, credential gateway — with per-listener behavior written down: console and control socket take the remote-mode auth layer; the credential gateway is loopback-always and never joins remote mode.
3. Thread remote mode into the console API and the control socket: every remote console request requires the operator token; control-socket calls to operator-only methods or surfaces require the operator token, while a scoped T-1004 worker bearer remains valid only for workerMethods and binds that worker's identity for T-1204. Refuse missing or unregistered bearers everywhere, and return unauthorized when a remote worker bearer attempts an operator-only surface. The console additionally requires the per-install proxy shared-secret header (generated at boot, stored next to the operator token) before honoring forwarded identity.
4. Verify the operator token file's permissions at boot: anything looser than 0600 refuses to start.
5. Tests: bind refusal is unconditional; every remote console request and operator-only control call requires the operator token; scoped worker bearers remain valid only for workerMethods and bind worker identity; missing, unregistered, and wrong-authority bearers are refused; a direct loopback caller with forged X-Forwarded-* headers gains nothing; constant-time token comparison remains; and every existing suite passes unchanged on the loopback default.

## Acceptance

- [x] Any non-loopback bind exits before any listener opens, with the reason on stderr — the flag does not permit one.
- [x] A remote console request without the operator token is refused.
- [x] A remote control-socket call to an operator-only method or surface without the operator token is refused; a scoped worker bearer is unauthorized there.
- [x] A scoped worker bearer remains valid only for workerMethods and binds worker identity for T-1204.
- [x] A missing or unregistered bearer is refused everywhere.
- [x] Token comparison is constant-time on every listener, including the control socket's identity lookup.
- [x] The operator token file's permissions are verified at boot (0600, else refuse).
- [x] A direct loopback caller with forged X-Forwarded-* headers gains nothing in remote mode.
- [x] Loopback behavior is unchanged, and every existing suite stays green.

Evidence:

| Claim | Anchor |
|---|---|
| Commit 65ba0a8 wires explicit remote mode and refuses non-loopback binds before listeners open | [`src/daemon/main.ts`](../../../src/daemon/main.ts) |
| Commit 65ba0a8 enforces operator and scoped-worker authority on the control socket | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| Commit 65ba0a8 covers bind refusal, authentication boundaries, forged forwarded headers, and unchanged loopback defaults | [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) |

## Out of scope

- TLS itself (T-1202, via proxy per ADR-012) and the console's login UX (T-1203).

## Depends on

- T-1004

## Unblocks

- T-1202
- T-1203
- T-1204
- T-1206
