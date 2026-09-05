# T-1303 — Manual-dispatch release workflow

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Done | [asset-map](../asset-map.md) |

## Goal

An operator dispatches the release workflow with a tag; the workflow verifies the release and its single packed tarball, then automatically publishes that tarball, with ADR-013's pid-contract state asserted as a pipeline step, not a wiki note.

## Read first

- [CI workflow](../../../.github/workflows/ci.yml)
- [Package manifest](../../../package.json)
- [ADR-013: release channel](../../../docs/delivery/adr/ADR-013-release-channel.md)

## Files this task may change

- `.github/workflows/release.yml`
- `.github/workflows/prepare-release.yml`
- `.github/workflows/draft-changelog.yml`
- `package.json`
- `biome.json`
- `scripts/cut-changelog.ts`
- `tests/cut-changelog.test.ts`
- `docs/develop/release.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) | Edited | Manual dispatch with required tag input; verifies one tarball, then automatically publishes that exact artifact with provenance through the npm-publish environment. |
| [`.github/workflows/prepare-release.yml`](../../../.github/workflows/prepare-release.yml) | New | Cuts Unreleased, bumps versions, opens a release PR. |
| [`.github/workflows/draft-changelog.yml`](../../../.github/workflows/draft-changelog.yml) | New | Drafts Unreleased from conventional commits since the last tag. |
| [`package.json`](../../../package.json) | Edited | publishConfig and the version/omp.version pair the tag step asserts. |
| [`biome.json`](../../../biome.json) | Edited | Ignores Archify diagram JSON/SVG and brand rasters so the release lint gate can pass. |
| [`scripts/cut-changelog.ts`](../../../scripts/cut-changelog.ts) | New | Keep-a-Changelog cut, notes extract, commit draft, manifest bump. |
| [`tests/cut-changelog.test.ts`](../../../tests/cut-changelog.test.ts) | New | Non-vacuity: empty Unreleased refuses to cut. |
| [`docs/develop/release.md`](../../../docs/develop/release.md) | New | Operator ritual and GitHub settings checklist. |

## Steps

1. Expose only `workflow_dispatch`, with a required `tag` input; dispatch authorizes publication, checkout and the version gate use `inputs.tag`, and the gate asserts tag == package.json version == omp.version before publication is possible.
2. Always run version/changelog validation, patch hygiene, typecheck and fast suites through the pack lifecycle, the console suite, lint, delivery-doc drift checks, pack assertions, and the consumer-install smoke asserting the current RpcClient.pid state: 'pid absent, degraded supervision'.
3. Create one tarball, retain it as the verified artifact through every pack and consumer assertion, and automatically publish that exact tarball after verification succeeds.
4. Publish the verified tarball with `npm publish <tarball> --provenance`; the job declares `permissions: id-token: write`, and the manifest sets publishConfig.access to "public" for the scoped name.

## Acceptance

- [x] The workflow has only a manual `workflow_dispatch` trigger with required `tag`; checkout and version validation use `inputs.tag`, and no second publication opt-in is required.
- [x] Every dispatch runs version/changelog validation, patch hygiene, typecheck and fast suites through the pack lifecycle, the console suite, lint, docs drift, pack assertions, and the consumer-install smoke with RpcClient.pid in the 'pid absent, degraded supervision' state.
- [x] The publish job depends on successful release verification, retains the npm-publish environment gate and id-token: write, and publishes public with --provenance.
- [x] Publication uses the same single tarball already exercised by pack assertions and the consumer-install smoke; no publish-time rebuild can change the artifact.

Evidence:

| Claim | Anchor |
|---|---|
| Manual release dispatch verifies one tarball before automatic npm publication | [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) |
| Commit 264207d supplies release lifecycle commands | `package.json §scripts` |

## Out of scope

- npm Trusted Publishing setup on npmjs.com (operator-owned).

## Depends on

- T-1301
- T-1302
- T-1306

## Unblocks

- Nothing.
