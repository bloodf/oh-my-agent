# T-1616 — A saturated audit stays readable on the control socket

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

When the live connection audit is full, the control socket answers with a JSON-RPC failure frame carrying the daemon's own reason, so `omp-agent audit` -- the verb an operator reaches for at exactly that moment -- prints why instead of a JSON parser's complaint.

## Read first

- [Control socket cap refusal](../../../src/daemon/socket.ts)
- [The CLI's JSON-RPC client](../../../src/daemon/cli.ts)
- [The console API's cap refusal, already correct](../../../src/daemon/console-api.ts)
- [Exposure suite](../../../tests/remote-exposure.test.ts)

## Files this task may change

- `src/daemon/socket.ts`
- `tests/remote-exposure.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | The audit-capacity refusal returns a JSON-RPC failure frame through the existing `failure` helper rather than a bare-text body, matching what console-api.ts already returned for the same condition. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | Edited | Created by T-1201; a 33rd control connection at the cap is asserted to be a parseable JSON-RPC error, and `runCli(['audit'])` is asserted to print the daemon's reason and never 'Failed to parse JSON'. |

## Steps

1. Reproduce against a real proxy: hold 32 authenticated console WebSockets open, then run `omp-agent audit` on the daemon host.
2. Return the capacity refusal through the same `failure` helper every other control-socket error uses, keeping the 503 status and the existing message.
3. Assert both surfaces: the wire frame parses as JSON-RPC with the daemon's message, and the CLI prints that message rather than a parser error.

## Acceptance

- [x] At the audit cap the control socket returns HTTP 503 whose body is a JSON-RPC failure frame carrying `Connection audit capacity reached`.
- [x] `omp-agent audit` at the cap exits 4 and prints the daemon's reason, never `Failed to parse JSON`.

Evidence:

| Claim | Anchor |
|---|---|
| The audit-capacity refusal returns a JSON-RPC failure frame | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| A control connection at the cap is a readable JSON-RPC error, CLI surface included | [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) |
| Found by the 33rd-connection check of the 2026-09-03 real-proxy runs; the fix was re-verified through real Caddy at the cap | [`docs/remote-exposure.md`](../../../docs/remote-exposure.md) |

## Out of scope

- Changing the cap itself, or the console API's refusal, which already returned JSON.

## Depends on

- Nothing.

## Unblocks

- Nothing.
