# T-004 — Auth broker wire-protocol contract

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-00](../epics/EP-00-foundations-and-contracts.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

The broker's snapshot, long-poll, block, and refresh shapes are pinned against the real server.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `tests/contracts/broker.contract.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/contracts/broker.contract.test.ts`](../../../tests/contracts/broker.contract.test.ts) | New | Exercises `startAuthBroker`. |
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | Read only, not edited by this task | Proxies this protocol. |

## Steps

1. Start a real broker on an ephemeral loopback port.
2. Assert snapshot shape, ETag semantics, conditional long-poll, block, and refresh.
3. Seed credentials through `store.upsertAuthCredentialForProvider` then `storage.reload()`, since `AuthStorage` exposes no direct add.

## Acceptance

- [x] 8 tests pass against `startAuthBroker`.
- [x] Generation and ETag semantics are asserted, not assumed.

Evidence:

| Claim | Anchor |
|---|---|
| Broker contract, 8 tests | [`tests/contracts/broker.contract.test.ts`](../../../tests/contracts/broker.contract.test.ts) |
| Commit | `f9ae30e` |

## Out of scope

- Nothing deferred.

## Depends on

- T-002

## Unblocks

- T-301
- T-510
