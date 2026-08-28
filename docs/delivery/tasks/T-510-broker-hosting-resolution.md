# T-510 — Broker hosting resolution at boot

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Done | [asset-map](../asset-map.md) |

## Goal

The daemon decides at boot whether to reuse a broker the user already runs or embed its own, and takes custody of the admin token either way.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Broker contract](../../../tests/contracts/broker.contract.test.ts)
- [Gateway](../../../src/daemon/credential-gateway.ts)

## Files this task may change

- `src/daemon/boot.ts`
- `tests/daemon-boot.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/boot.ts`](../../../src/daemon/boot.ts) | New | `resolveBrokerHosting`: discovery, probe, custody. |
| [`tests/daemon-boot.test.ts`](../../../tests/daemon-boot.test.ts) | New | 14 tests. |
| [`src/daemon/credential-gateway.ts`](../../../src/daemon/credential-gateway.ts) | Read | Fronts the resolved hosting with per-worker tokens. |

## Steps

1. Follow OMP's own discovery chain in order: `OMP_AUTH_BROKER_URL` in the environment, then `auth.broker.*` in the agent config, then the token file. Inventing a different order would make the daemon disagree with every other OMP client on the same machine.
2. Probe a discovered broker twice: reachable, and willing to accept the token. A configured-but-dead broker fails boot rather than silently falling back, because a silent fallback splits the user's credentials across two vaults.
3. Treat an external broker's token as read-only: the daemon did not mint it and must not rotate or rewrite it.
4. For the embedded case, start `startAuthBroker` over the shared vault and mint a fresh in-memory admin token per boot, so a token never outlives the process that owns it or lands on disk.
5. Expose the hosting as a value the gateway consumes; workers never see `adminToken`.

## Acceptance

- [x] An `OMP_AUTH_BROKER_URL` in the environment wins over config and token file.
- [x] A configured broker that fails either probe fails boot instead of falling back to embedded.
- [x] An external broker's token is never rewritten.
- [x] The embedded broker's admin token is freshly generated and not persisted.
- [x] 14 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Boot suite, 14 tests | [`tests/daemon-boot.test.ts`](../../../tests/daemon-boot.test.ts) |

## Out of scope

- Composing the rest of the daemon around this, which is T-502.
- Per-worker token issuance, which T-301 owns.

## Depends on

- T-004

## Unblocks

- Nothing.
