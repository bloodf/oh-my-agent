# T-1301 — Files allowlist and the pack test

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Done | [asset-map](../asset-map.md) |

## Goal

`npm pack` produces a tarball with exactly what the plugin needs — manifest, sources, skills, console assets, the patches contract, LICENSE, README — and the suite proves it.

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
| [`patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch) | Read-only | Reapplied by bun install for anyone working from a checkout. It does not travel in the npm tarball: npm 12 strips the file a patchedDependencies entry names, and ADR-013 had already established the patch cannot reach a consumer through a tarball. |
| [`tests/pack.test.ts`](../../../tests/pack.test.ts) | New | Parses `npm pack --dry-run --json` and asserts both directions: expected paths present, private paths absent. |

## Steps

1. Author the files allowlist: src, skills, patches, LICENSE, README — skills/ is load-bearing (the materializer throws Unknown skill without it) and is in the manifest today. Tests, docs, and .github stay out. patches/ stays in the allowlist for developers installing from a checkout, but npm 12 strips the patched file from the tarball regardless.
2. prepack runs typecheck and the fast suites; packing a broken tree fails before the tarball exists.
3. The pack test asserts the dry-run manifest both ways — expected paths present, nothing under tests/, docs/, or .github/ ships — with explicit presence asserts for the console assets (src/console/*.html/css/js), every skills/*/SKILL.md, and LICENSE, so a future src/ restructure cannot drop them silently.

## Acceptance

- [x] The dry-run manifest contains src/ (the src/console/*.html/css/js assets included), skills/ with every SKILL.md, LICENSE, and README.md, and nothing under tests/, docs/, or .github/. Nothing under patches/ ships either: npm 12 strips the file a patchedDependencies entry names, and per ADR-013 that patch could never have taken effect for a consumer anyway, because Bun honors patchedDependencies only from the consumer's root manifest.
- [x] CI runs the pack test; a manifest regression fails the build.

Evidence:

| Claim | Anchor |
|---|---|
| Commit 3c3f611 defines the published package allowlist | `package.json § files` |
| Commit 3c3f611 proves the packed manifest; the pack test asserts presence and absence in both directions | [`tests/pack.test.ts`](../../../tests/pack.test.ts) |

## Out of scope

- Publishing itself (T-1303), the consumer-install smoke test (T-1306), and removing the patch (T-1504).

## Depends on

- Nothing.

## Unblocks

- T-1303
- T-1304
- T-1306
