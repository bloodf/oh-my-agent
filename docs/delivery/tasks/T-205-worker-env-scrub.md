# T-205 — Worker env scrub

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-02](../epics/EP-02-worker-isolation.md) | [SP-02](../sprints/SP-02-isolation.md) | Done | [asset-map](../asset-map.md) |

## Goal

A worker's environment cannot be rerouted by whatever the machine that launched the daemon happens to export.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Materializer](../../../src/daemon/materializer.ts)
- [Hermetic test env](../../../tests/fixtures/hermetic-env.ts)
- [ADR-002: private store and materialized roots](../../../docs/delivery/adr/ADR-002-private-store-materialized-roots.md)

## Files this task may change

- `src/shared/env-scrub.ts`
- `src/daemon/materializer.ts`
- `tests/fixtures/hermetic-env.ts`
- `tests/materializer.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/env-scrub.ts`](../../../src/shared/env-scrub.ts) | New | The one canonical scrub list plus `withoutScrubbedEnvVars`. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Edited | Neutralizes inherited selectors in the materialized worker env. |
| [`tests/fixtures/hermetic-env.ts`](../../../tests/fixtures/hermetic-env.ts) | Edited | Consumes the production list instead of keeping its own copy. |
| [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) | Edited | Poisoned-env regression. |

## Steps

1. Put the scrub list in `src/shared/env-scrub.ts` and have both production and the test fixture read it. Two lists is one list plus a bug: the copy that is not updated is the one that matters.
2. Blank the selectors rather than deleting them. OMP's `RpcClient` merges the worker env over `Bun.env`, so a deleted key falls back to the host's value; only an explicit empty string overrides it.
3. Cover every config-root selector: `PI_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and the profile variables.
4. Apply the scrub inside materialization, where the worker env is built, so no caller can construct a worker env that skips it.
5. Prove the regression is not vacuous: with the scrub reverted and a poisoned `PI_CONFIG_DIR` exported, the test must fail.

## Acceptance

- [x] A materialized worker env blanks every selector in the canonical list.
- [x] With `PI_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` exported by the host, a worker still resolves to its own materialized root.
- [x] Production and the test fixture share one scrub list, asserted by importing it in both.
- [x] The poisoned-env regression fails with the scrub reverted, proving it is not vacuous.

Evidence:

| Claim | Anchor |
|---|---|
| Canonical scrub list shared by production and the test fixture | [`src/shared/env-scrub.ts`](../../../src/shared/env-scrub.ts) |
| Poisoned-env regression, proven non-vacuous (materializer suite) | [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) |

## Out of scope

- Broader credential-env hygiene: provider API keys inherited into the daemon host env are still visible to a worker's own process env. That is a real gap and a known follow-up, but it is a credential-scoping question (EP-03's territory) rather than a config-root one, and folding it in here would mean two unrelated threat models in one change.

## Depends on

- T-201

## Unblocks

- Nothing.
