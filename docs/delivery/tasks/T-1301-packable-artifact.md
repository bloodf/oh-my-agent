# T-1301 — Files allowlist and the pack test

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Ready | [asset-map](../asset-map.md) |

## Goal

`npm pack` produces a tarball with exactly what the plugin needs — manifest, sources, console assets, the patches contract, LICENSE, README — and the suite proves it.

## Read first

- [Package manifest](../../../package.json)
- [ADR-013: release channel](../../../docs/delivery/adr/ADR-013-release-channel.md)
- [CI workflow](../../../.github/workflows/ci.yml)

## Files this task may change

- `package.json`
- `tests/pack.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`package.json`](../../../package.json) | Edited | The files allowlist and a prepack script that runs the gates. |
| `tests/pack.test.ts` (to be created) | New | Parses `npm pack --dry-run --json` and asserts both directions: expected paths present, private paths absent. |

## Steps

1. Author the files allowlist: src, patches, LICENSE, README. Tests, docs, and .github stay out.
2. prepack runs typecheck and the fast suites; packing a broken tree fails before the tarball exists.
3. The pack test asserts the dry-run manifest both ways: expected present, and nothing under tests/, docs/, or .github/ ships.

## Acceptance

- [ ] The dry-run manifest contains src/, patches/, LICENSE, and README.md, and nothing under tests/, docs/, or .github/.
- [ ] CI runs the pack test; a manifest regression fails the build.

## Out of scope

- Publishing itself (T-1303) and the patch-travel decision (ADR-013, implemented in T-1303 or resolved by T-1503).

## Depends on

- Nothing.

## Unblocks

- T-1303
- T-1304
