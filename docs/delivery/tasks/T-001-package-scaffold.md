# T-001 — Plugin package scaffold

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-00](../epics/EP-00-foundations-and-contracts.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

OMP recognises the repository as an installable plugin exposing one extension.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Repo layout](../../../ARCHITECTURE.md)

## Files this task may change

- `package.json`
- `tsconfig.json`
- `src/extension/index.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`package.json`](../../../package.json) | New | Declares `omp.extensions`. |
| [`src/extension/index.ts`](../../../src/extension/index.ts) | New | Extension factory; body lands in T-501. |

## Steps

1. Create the package manifest with `omp.name`, `omp.version`, and the extension path.
2. Pin OMP packages as peer plus dev dependencies so tests resolve the real build.
3. Add `typecheck` and `test` scripts.

## Acceptance

- [x] `bun test` and `tsc --noEmit` both run clean on an empty tree.
- [x] The manifest names `src/extension/index.ts` under `omp.extensions`.

Evidence:

| Claim | Anchor |
|---|---|
| Scaffold suite, 4 tests | [`tests/scaffold.test.ts`](../../../tests/scaffold.test.ts) |
| Commit | `c7b90bd` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-002
