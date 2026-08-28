# EP-03 — Scoped credential gateway

**Status:** Done

*Derived from the tasks below.*

## Outcome

Workers reach model credentials only through a loopback gateway that shows each one exactly the accounts it is bound to.

## Why this is its own epic

The upstream admin token is vault-wide. Without a gateway, every peer holds every credential the user owns, co-tenant accounts included, and revocation is all-or-nothing. This epic is the difference between multi-agent and multi-tenant.

## In scope

- Per-worker revocable bearer tokens bound to credential ids.
- Filtered snapshot, stream, refresh, block, and usage routes.
- Monotonic worker-view generations independent of upstream numbering.
- Shared-account disable returning `409 pending_policy` with requester recovery.

## Not in scope

- Replacing OMP's broker; the daemon reuses `startAuthBroker`.

## Acceptance

- [x] Two workers on the same gateway see disjoint credential sets.
- [x] A foreign credential id returns 403 on every scoped route.
- [x] Usage data is filtered by affirmative identity match, never by provider fallback.
- [x] A shared disable leaves upstream unchanged and peers usable.
- [x] A real `RemoteAuthCredentialStore` works against the gateway and recovers from a refused shared disable (T-303).

## Decisions

- [ADR-003](../adr/ADR-003-scoped-credential-gateway.md) — Workers reach credentials only through a scoped per-worker gateway
- [ADR-004](../adr/ADR-004-provider-override-not-custom-model.md) — Worker config emits a provider override, never a custom model entry

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-301](../tasks/T-301-credential-gateway.md) | Scoped per-worker credential gateway | Done |
| [T-302](../tasks/T-302-shared-disable-recovery.md) | Shared-account disable and requester recovery | Done |
| [T-303](../tasks/T-303-client-integration.md) | Drive the gateway with a real credential store | Done |
