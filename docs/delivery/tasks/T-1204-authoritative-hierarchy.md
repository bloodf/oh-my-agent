# T-1204 — Hierarchy enforcement flips in remote mode

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

In remote mode, parentage stops being cooperative metadata: kill, inject, and spawn-parent claims are enforced against the caller's identity, and the cooperative path is unreachable remotely.

## Read first

- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)
- [Control socket](../../../src/daemon/socket.ts)
- [Identity suite](../../../tests/socket-identity.test.ts)

## Files this task may change

- `src/daemon/socket.ts`
- `tests/socket-identity.test.ts`
- `tests/remote-exposure.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Remote mode flips the enforcement switch T-1004 built; loopback keeps cooperative behavior. |
| [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) | Edited | The enforcement assertions run in remote mode. |
| `tests/remote-exposure.test.ts` (to be created) | Edited | The flip is on in remote mode and off on loopback — both asserted. |

## Steps

1. Wire the remote-mode flag to T-1004's enforcement: a worker token's kill, bump, or inject is refused against peers it does not own; a spawn's parent claim must equal the caller identity.
2. Assert the negative space: loopback keeps cooperative parentage (existing suites stand), remote mode has no cooperative path.
3. Boot in remote mode logs the active trust model once, so an operator can audit which is live.

## Acceptance

- [ ] Remote mode: every privileged verb refuses a foreign-identity caller, suite-proven over the proxied connection shape.
- [ ] Loopback: cooperative behavior and the existing suites are unchanged.
- [ ] The boot log names the active trust model.

## Out of scope

- Room ACLs beyond parentage (ADR-011's list); identity grows no new powers here.

## Depends on

- T-1201

## Unblocks

- Nothing.
