# T-1005 — Allowlist the worker environment

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Planned | [asset-map](../asset-map.md) |

## Goal

A worker's process env contains only what its layout declares — provider keys and other host secrets in the daemon's environment never reach a child.

## Read first

- [Env scrub](../../../src/shared/env-scrub.ts)
- [Materializer env](../../../src/daemon/materializer.ts)
- [ADR-002: materialized roots](../../../docs/delivery/adr/ADR-002-private-store-materialized-roots.md)

## Files this task may change

- `src/daemon/materializer.ts`
- `src/worker/lifecycle.ts`
- `src/shared/env-scrub.ts`
- `tests/materializer.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Edited | The worker env becomes an allowlist, not a blanklist. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | The spawn env is exactly the layout's env plus declared passthroughs. |
| [`src/shared/env-scrub.ts`](../../../src/shared/env-scrub.ts) | Edited | The canonical list gains the allowlist side. |
| [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) | Edited | A poisoned host env (OPENAI_API_KEY etc.) reaches the worker only when declared. |

## Steps

1. Pick this up WHEN workers run definitions from authors you do not fully trust, or the daemon host env carries provider keys (it usually does). T-205 scrubbed the config-root selectors; this is the rest of the host env.
2. Invert the scrub: the spawned env is the layout's declared map plus an explicit passthrough list (PATH, HOME-shape basics, locale), never `...Bun.env` of the host.
3. Prove with a poisoned host env that nothing undeclared reaches the child, including through the sandbox-gate launch path.

## Acceptance

- [ ] A host exporting provider keys produces a worker env without them.
- [ ] The declared passthroughs keep the child functional (the real-child suites stay green).
- [ ] The sandbox launch path is covered by the same assertions.

## Out of scope

- OS sandboxing itself (EP-02, shipped) and network egress policy (sandbox-bridge territory).

## Depends on

- T-205

## Unblocks

- Nothing.
