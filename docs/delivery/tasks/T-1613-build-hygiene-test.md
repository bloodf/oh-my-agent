# T-1613 — Dependency-free console build hygiene

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A machine-enforced manifest test preserves the dependency-free console by rejecting a build script or runtime dependency.

## Read first

- [Package manifest](../../../package.json)
- [Console implementation](../../../src/console/app.js)

## Files this task may change

- `tests/build-hygiene.test.ts`
- `package.json`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `tests/build-hygiene.test.ts` (to be created) | New | Asserts scripts.build is absent and runtime dependencies remain empty using manifest fixtures. |
| [`package.json`](../../../package.json) | Read only, not edited by this task | The live manifest contract the test protects. |

## Steps

1. Add a dependency-free test that loads the live manifest and rejects scripts.build or any runtime dependency.
2. Exercise the predicate against fixtures that add a build script and a dependency so both guards prove non-vacuous.

## Acceptance

- [ ] The test fails when a fixture manifest adds a build script or a dependency.

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
