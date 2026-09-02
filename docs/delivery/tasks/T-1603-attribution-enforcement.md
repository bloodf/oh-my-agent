# T-1603 — Enforce attribution from connection identity

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

ADR-014 is enforced: console actions speak as the human and worker chat actions speak as the authenticated peer.

## Read first

- [Attribution policy](../../../docs/delivery/adr/ADR-014-attribution-policy.md)
- [Console post and reaction handlers](../../../src/daemon/console-api.ts)
- [Worker method dispatcher](../../../src/daemon/socket.ts)

## Files this task may change

- `src/daemon/console-api.ts`
- `src/daemon/socket.ts`
- `tests/console-api.test.ts`
- `tests/socket-identity.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Derives HUMAN_AUTHOR server-side; forged client attribution is ignored and logged for compatibility. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Overwrites worker chat_send, chat_react, and chat_unreact attribution with identity.peerName while preserving operator override. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Proves a forged console author stores @you. |
| [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) | Edited | Proves worker binding and the documented privileged operator override. |

## Steps

1. Keep accepting the console author field for compatibility, but ignore and log it; derive HUMAN_AUTHOR server-side.
2. For worker-token chat_send, chat_react, and chat_unreact, overwrite payload attribution with identity.peerName; leave operator-token override privileged and document it at the dispatcher contract.
3. Add negative identity tests for forged console and worker attribution plus the retained operator privilege.

## Acceptance

- [x] A worker posting with author='@other' is recorded under its own peer name, suite-proven.
- [x] A console post with a forged author stores @you.
- [x] Operator-token attribution override still works and is documented as privileged.

Evidence:

| Claim | Anchor |
|---|---|
| console derives HUMAN_AUTHOR server-side; worker attribution overwritten with identity | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
| Commit | `4e0410e` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
