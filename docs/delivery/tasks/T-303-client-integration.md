# T-303 — Drive the gateway with a real credential store

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-03](../epics/EP-03-credential-gateway.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A stock `RemoteAuthCredentialStore` is proven to work against the gateway, including recovering from a refused shared disable.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Gateway](../../../src/daemon/credential-gateway.ts)
- [Gateway suite](../../../tests/credential-gateway.test.ts)

## Files this task may change

- `tests/gateway-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `tests/gateway-client.test.ts` (to be created) | New | Integration suite using the real client. |
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | Read | Subject under test; no change expected. |
| [`node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts`](../../../node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts) | Read only, not edited by this task | The client whose behavior is currently inferred rather than exercised. |

## Steps

1. Point a real `RemoteAuthCredentialStore` at the gateway with a worker token, rather than issuing raw `fetch` calls as the existing suite does.
2. Assert it loads exactly the bound credentials and follows the stream through an upstream change.
3. Request a shared-account disable and assert the store ends holding the credential again, since it removes it optimistically and only a full snapshot with a not-older generation puts it back. This is the step the existing suite cannot perform.
4. Assert a peer store on the same gateway is unaffected throughout.
5. If the client turns out to need a behavior the gateway does not provide, fix the gateway; do not weaken the assertion to match.

## Acceptance

- [ ] A real store loads only its bound credentials through the gateway.
- [ ] After a refused shared disable, the requester's store holds the credential again without a manual reload.
- [ ] A peer's store is unaffected by the requester's refused disable.
- [ ] An upstream change reaches the real store through the gateway's stream.

## Out of scope

- Changing gateway semantics; T-301 and T-302 own those.

## Depends on

- T-302

## Unblocks

- Nothing.
