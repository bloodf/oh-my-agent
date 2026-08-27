# ADR-003 — Workers reach credentials only through a scoped per-worker gateway

**Status:** Accepted

## Context

The auth broker's admin token is vault-wide. Handing it to a worker gives that worker every credential the user owns, including co-tenants' accounts, and makes revocation all-or-nothing.

## Decision

The daemon holds the upstream token alone and fronts it with a loopback gateway. Each worker gets its own revocable bearer token bound to specific credential ids. The gateway filters snapshot, stream, refresh, block, and usage routes, and rewrites upstream generations into a monotonic per-worker view.

## Consequences

- A leaked worker token exposes one account and is revocable on its own.
- Foreign-id access returns 403; credential upload and client usage stay admin-only.
- A shared-account disable cannot be unilateral: it returns `409 pending_policy` and queues a request.
- Aggregate usage is account-filtered by affirmative identity match, so an API-key binding matches nothing rather than falling back to provider.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Give workers the admin token | One compromised peer owns the whole vault, and revocation is all-or-nothing. |
| Per-worker broker instance | Duplicates vault state and multiplies refresh races on the same upstream account. |

## Evidence

| Claim | Source |
|---|---|
| Gateway implementation | [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) |
| Broker wire protocol pinned against startAuthBroker | [`tests/contracts/broker.contract.test.ts`](../../../tests/contracts/broker.contract.test.ts) |
| Identity match semantics mirror upstream | [`node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts:1423-1436`](../../../node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts) |
