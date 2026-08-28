# T-302 — Shared-account disable and requester recovery

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-03](../epics/EP-03-credential-gateway.md) | [SP-03](../sprints/SP-03-credentials.md) | Done | [asset-map](../asset-map.md) |

## Goal

One worker cannot unilaterally disable a credential its peers depend on, and recovers cleanly when refused.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Gateway](../../../src/daemon/credential-gateway.ts)

## Files this task may change

- `src/daemon/credential-gateway.ts`
- `tests/credential-gateway.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | Edited | Pending-policy path. |
| [`tests/credential-gateway.test.ts`](../../../tests/credential-gateway.test.ts) | Edited | Recovery and long-poll cases. |

## Steps

1. Return `409 pending_policy` with a request id when the account is shared, and queue `{credentialId, workerId}`.
2. Leave upstream untouched, so peers keep working.
3. Bump only the requester's worker-view generation and emit a full snapshot, because `RemoteAuthCredentialStore` optimistically removes the credential locally and only a full snapshot with a not-older generation restores it.
4. Proxy a dedicated-account disable straight through.

## Acceptance

- [x] A shared disable returns 409 with a request id and leaves upstream unchanged.
- [x] The requester's long-poll wakes with a full snapshot carrying a newer generation.
- [x] A peer's long-poll is not woken by another worker's pending disable.
- [x] A dedicated-account disable proxies upstream and returns its result.

Evidence:

| Claim | Anchor |
|---|---|
| Recovery and long-poll cases | [`tests/credential-gateway.test.ts`](../../../tests/credential-gateway.test.ts) |
| Commit | `c5e3e75` |

## Out of scope

- Proving a real `RemoteAuthCredentialStore` restores the credential. These suites drive the gateway with `fetch`, so the wire response is verified but the client's reaction to it is inferred from upstream source, not exercised. T-303 closes that gap.

## Depends on

- T-301

## Unblocks

- T-303
