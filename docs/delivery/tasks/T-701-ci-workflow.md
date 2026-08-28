# T-701 — CI: typecheck, test, and delivery-doc drift

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-07](../epics/EP-07-release-readiness.md) | [SP-08](../sprints/SP-08-release-readiness.md) | Done | [asset-map](../asset-map.md) |

## Goal

A push proves the tree type-checks, the suite passes, and the delivery docs match their generator.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Delivery generator](../../../scripts/gen-delivery-docs.py)
- [Delivery tree contract](../../../docs/delivery/README.md)

## Files this task may change

- `.github/workflows/ci.yml`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | New | Install, typecheck, test, lint, docs-drift. |
| [`package.json`](../../../package.json) | Read | Supplies the `typecheck` and `test` scripts CI invokes. |
| [`scripts/gen-delivery-docs.py`](../../../scripts/gen-delivery-docs.py) | Read | Re-run in CI; its output must match what is committed. |

## Steps

1. Run on push and pull request, on a single `ubuntu-latest` runner with `oven-sh/setup-bun`; there is no per-OS behavior in the suite worth a matrix's cost.
2. `bun install --frozen-lockfile`, so a drifted lockfile fails here rather than surprising the next developer.
3. Run `tsc --noEmit`, then `bun test`. Keep them separate steps: a type error and a failing assertion are different problems and should not share a red X.
4. Run `bunx biome check .` so style failures fail the build beside behavioral ones.
5. Regenerate the delivery tree with `python3 scripts/gen-delivery-docs.py` and fail on any diff under `docs/delivery/`. A generated tree nobody re-generates is a hand-maintained tree with extra steps.
6. Do not cache aggressively: `bun install` on this dependency set is cheap, and a stale cache that hides a resolution failure costs more than it saves.

## Acceptance

- [x] A push runs install, typecheck, and test, and a failure in any one fails the build.
- [x] Committing a hand-edit to `docs/delivery/` fails CI with the diff shown.
- [x] Regenerating and committing that same edit's source in the generator makes CI green again.
- [x] The workflow is verified by pushing it, not by reading it: a workflow that has never run is a guess.

Evidence:

| Claim | Anchor |
|---|---|
| Workflow file | [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) |
| First push green: install, typecheck, test, lint, docs-drift (run 33134780907, 48s) | `https://github.com/bloodf/oh-my-agent/actions` |

## Out of scope

- Publishing, tagging, and release automation.

## Depends on

- Nothing.

## Unblocks

- Nothing.
