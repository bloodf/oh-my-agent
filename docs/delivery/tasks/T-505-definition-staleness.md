# T-505 — Rebuild a worker when its definition changes

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A parked worker whose definition changed is rebuilt before it is reused.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Materializer](../../../src/daemon/materializer.ts)
- [Lifecycle](../../../src/worker/lifecycle.ts)

## Files this task may change

- `src/daemon/supervisor.ts`
- `src/worker/lifecycle.ts`
- `src/daemon/peer-store.ts`
- `tests/supervisor.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Fingerprint check and rebuild before wake. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | Replace a parked worker's layout after re-materialization. |
| `src/daemon/peer-store.ts` (to be created) | Edited | Re-read the definition so the comparison uses current disk state. |
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | Read | `fingerprintPeerDefinition` already exists. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Read | Performs the rebuild; T-201 owns it. |

## Steps

1. Re-read the definition from the peer store before comparing, since a fingerprint recomputed from the in-memory copy can never differ from itself.
2. Recompute the effective fingerprint before every wake or scheduled run.
3. On a match reuse the parked worker; on a mismatch stop it, re-materialize, and start a fresh session before delivering.
4. Give the worker handle a way to adopt the rebuilt layout, because its current layout and fingerprint are fixed at construction.
5. Deliver only after the rebuild, so a message is never handled by a worker running a superseded policy.

## Acceptance

- [ ] An unchanged definition reuses the parked worker with no re-materialization.
- [ ] A changed definition rebuilds the worker directory and starts a fresh session.
- [ ] Messages queued during the rebuild are delivered afterwards, not dropped.
- [ ] No policy-changing file is mutated under a live process.

## Out of scope

- Nothing deferred.

## Depends on

- T-501
- T-502

## Unblocks

- Nothing.
