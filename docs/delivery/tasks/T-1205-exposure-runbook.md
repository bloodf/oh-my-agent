# T-1205 — Threat model and operator checklist

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

One page an operator reads before flipping remote mode: the threat model, the checklist, and the audit commands — so 'should I enable this' has a written answer.

## Read first

- [ADR-012: remote exposure](../../../docs/delivery/adr/ADR-012-remote-exposure.md)
- [README](../../../README.md)
- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `docs/remote-exposure.md`
- `README.md`
- `ARCHITECTURE.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `docs/remote-exposure.md` (to be created) | Edited | The threat-model and checklist sections land here; T-1202's recipes reference them. |
| [`README.md`](../../../README.md) | Edited | A remote-access section pointing at the runbook, not duplicating it. |
| [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) | Edited | The trust-model section names remote mode and its preconditions. |

## Steps

1. Threat model: what the operator token protects (room contents, kill authority, credentials via the gateway), what the proxy protects (transport), what stays out of scope (multi-tenant).
2. Checklist: flag set, token verified non-default, proxy TLS verified, enforcement state read from the boot log.
3. Audit commands: how to check which mode is live and which connections are authenticated.

## Acceptance

- [ ] The runbook names every precondition T-1201 enforces, in the same words the daemon prints on stderr.
- [ ] README and ARCHITECTURE point at the runbook; there is no duplicated threat model to drift.

## Out of scope

- Nothing deferred.

## Depends on

- T-1201

## Unblocks

- Nothing.
