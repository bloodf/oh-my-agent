# T-1206 — Authenticated-connection audit surface

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Done | [asset-map](../asset-map.md) |

## Goal

The daemon logs every authenticated remote-mode connection (identity, source, time) and a CLI verb reports the current mode plus the live authenticated connections — the audit commands T-1205 documents must exist.

## Read first

- [ADR-012: remote exposure](../../../docs/delivery/adr/ADR-012-remote-exposure.md)
- [Control socket](../../../src/daemon/socket.ts)
- [CLI verbs](../../../src/daemon/cli.ts)

## Files this task may change

- `src/daemon/socket.ts`
- `src/daemon/console-api.ts`
- `src/daemon/cli.ts`
- `tests/remote-exposure.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Logs identity, source, and time on every authenticated control-socket connection in remote mode; tracks the live set. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | The same log line for authenticated console connections in remote mode. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | The `audit` verb: prints the active trust model and the live authenticated connections. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | Edited | Created by T-1201; asserts the log lines and the verb output. |

## Steps

1. Log on authenticated connect in remote mode — identity, source (forwarded for proxied traffic), and time — on both the console API and the control socket.
2. Track the live authenticated connections so the verb can list them.
3. Add the `omp-agent audit` verb: reports the active trust model (loopback or remote) and the live authenticated connections.
4. Suite: assert the log lines on authenticated connect and the verb's output.

## Acceptance

- [x] Every authenticated remote-mode connection leaves a log line with identity and source.
- [x] `omp-agent audit` reports the active trust model and live authenticated connections.

Evidence:

| Claim | Anchor |
|---|---|
| Commit cc1187e records bounded authenticated remote connection metadata and tracks the live set | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| Commit cc1187e exposes the audit verb for trust mode and live authenticated connections | [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) |
| Commit cc1187e verifies connection logging and audit output | [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) |

## Out of scope

- Log retention and rotation; the daemon log's existing handling applies.

## Depends on

- T-1201

## Unblocks

- T-1205
