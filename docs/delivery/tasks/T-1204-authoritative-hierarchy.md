# T-1204 — Hierarchy enforcement flips in remote mode

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Done | [asset-map](../asset-map.md) |

## Goal

In remote mode, parentage stops being cooperative metadata: kill, inject, and spawn-parent claims are enforced against the caller's identity, and the cooperative path is unreachable remotely.

## Read first

- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)
- [Control socket](../../../src/daemon/socket.ts)
- [Identity suite](../../../tests/socket-identity.test.ts)

## Files this task may change

- `src/daemon/socket.ts`
- `src/daemon/main.ts`
- `tests/socket-identity.test.ts`
- `tests/remote-exposure.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Boot logs the active trust model once. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Remote mode flips the enforcement switch T-1004 built; loopback keeps cooperative behavior. |
| [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) | Edited | The enforcement assertions run in remote mode. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | Edited | Created by T-1201; real daemon boots assert the active trust-model log in both remote and loopback modes. |

## Steps

1. Wire the remote-mode flag to T-1004's enforcement, specified by set difference: every protocol method not in socket.ts's workerMethods is operator-only, and the suite iterates METHOD_NAMES so a future method is deny-by-default — the dangerous ones the old enumeration missed (definition_update, agent_create, schedules_arm, rooms_post) are covered by the difference, not named. A spawn's parent claim must equal the caller identity.
2. Assert the negative space: loopback keeps cooperative parentage (existing suites stand), remote mode has no cooperative path.
3. Boot in remote mode logs the active trust model once, so an operator can audit which is live.

## Acceptance

- [x] Remote mode: every privileged verb refuses a foreign-identity caller, suite-proven over a remote-mode connection.
- [x] Loopback: cooperative behavior and the existing suites are unchanged.
- [x] The boot log names the active trust model.

Evidence:

| Claim | Anchor |
|---|---|
| Commit 3a7bcb2 makes remote parentage authoritative while preserving cooperative loopback behavior | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| Commit 3a7bcb2 logs the active trust model at boot | [`src/daemon/main.ts`](../../../src/daemon/main.ts) |
| Commit 3a7bcb2 proves remote identity enforcement and loopback behavior | [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) |

## Out of scope

- Room ACLs beyond parentage (ADR-011's list); identity grows no new powers here.

## Depends on

- T-1201

## Unblocks

- Nothing.
