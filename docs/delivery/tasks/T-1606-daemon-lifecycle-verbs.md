# T-1606 — Daemon lifecycle verbs and logs

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The CLI can stop and restart a pidfile-validated daemon gracefully, daemon stderr persists across restarts, and logs can select worker or daemon source.

## Read first

- [Daemon boot and detached launcher](../../../src/daemon/main.ts)
- [CLI verb parser](../../../src/daemon/cli.ts)
- [Control socket dispatch](../../../src/daemon/socket.ts)
- [Protocol contract suite](../../../tests/protocol.contract.test.ts)

## Files this task may change

- `src/daemon/main.ts`
- `src/daemon/cli.ts`
- `src/daemon/socket.ts`
- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `tests/daemon-cli.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Persists detached daemon stderr and performs graceful shutdown/restart lifecycle. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | Adds daemon stop/restart and logs source selection. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Adds operator-only daemon_stop dispatch instead of signal-based control. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | Declares additive daemon_stop params and result. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Validates daemon_stop and logs source selection. |
| [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) | Edited | Covers stale/live pidfiles, restarts, daemon logs, and protocol shapes. |

## Steps

1. Add operator-only daemon_stop to the protocol and socket; validate pidfile ownership before graceful stop and restart.
2. Persist detached daemon stderr to its log file across restarts instead of discarding it.
3. Add worker-stderr-default and daemon source selection to logs, then cover protocol and real-daemon CLI behavior.

## Acceptance

- [ ] Stop is refused for a stale pidfile, graceful for a live one, and verified gone.
- [ ] The daemon log file captures stderr across restarts.
- [ ] Protocol contract coverage includes daemon_stop params and result.

## Out of scope

- Follow or tail -f mode.

## Depends on

- Nothing.

## Unblocks

- Nothing.
