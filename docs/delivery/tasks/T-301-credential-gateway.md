# T-301 — Scoped per-worker credential gateway

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-03](../epics/EP-03-credential-gateway.md) | [SP-03](../sprints/SP-03-credentials.md) | Done | [asset-map](../asset-map.md) |

## Goal

Each worker sees only the credentials its token is bound to, through a loopback proxy.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Broker contract](../../../tests/contracts/broker.contract.test.ts)

## Files this task may change

- `src/daemon/credential-gateway.ts`
- `tests/credential-gateway.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | New | Token issuance, filtering, generations. |
| [`tests/credential-gateway.test.ts`](../../../tests/credential-gateway.test.ts) | New | 44 tests. |

## Steps

1. Issue a revocable bearer token per worker, bound to explicit credential ids.
2. Filter snapshot, stream, refresh, block, and usage by those bindings; foreign ids return 403.
3. Rewrite upstream generations into a monotonic worker view, so upstream renumbering cannot make a worker's view go backwards.
4. Keep credential upload and `/v1/usage/clients` admin-only.
5. Filter usage by affirmative identity match; an API-key binding carries no account identity and must match nothing rather than falling back to provider.
6. Bind loopback only.

## Acceptance

- [x] Two workers see disjoint credential sets.
- [x] A foreign id returns 403 on refresh and block.
- [x] The worker-view generation never decreases.
- [x] An API-key binding sees no usage reports.
- [x] `close()` completes while a watcher is parked on a long-poll.
- [x] 44 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Gateway suite, 44 tests | [`tests/credential-gateway.test.ts`](../../../tests/credential-gateway.test.ts) |
| Commits | `0fea451, c5e3e75` |

## Out of scope

- Nothing deferred.

## Depends on

- T-004

## Unblocks

- T-302
- T-401
- T-1002
