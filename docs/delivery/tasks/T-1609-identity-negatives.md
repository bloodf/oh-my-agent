# T-1609 — Identity negative-path proofs

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The security ticket's unproven identity bullets become mutation-verified tests for forbidden worker inject and room-peer handoff prompting.

## Read first

- [Worker identity suite](../../../tests/socket-identity.test.ts)
- [Worker method authorization](../../../src/daemon/socket.ts)

## Files this task may change

- `tests/socket-identity.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/socket-identity.test.ts`](../../../tests/socket-identity.test.ts) | Edited | Proves worker-token inject never reaches the supervisor and room-peer handoff prompts its target. |

## Steps

1. Assert worker-token inject returns FORBIDDEN and the supervisor inject method is never called.
2. Assert a worker task_handoff to a room peer prompts the target.
3. Mutation-verify both tests by removing their dispatcher workerMethods or authorize entries and observing failure.

## Acceptance

- [ ] Both tests fail when the dispatcher's workerMethods/authorize entries are removed, mutation-verified.

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
