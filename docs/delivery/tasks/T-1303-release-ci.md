# T-1303 — Manual-dispatch release workflow

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Done | [asset-map](../asset-map.md) |

## Goal

An operator dispatches the release workflow with a tag; the workflow always verifies the release and its single packed tarball, then publishes that tarball only when the `publish` input is true, with ADR-013's pid-contract state asserted as a pipeline step, not a wiki note.

## Read first

- [CI workflow](../../../.github/workflows/ci.yml)
- [Package manifest](../../../package.json)
- [ADR-013: release channel](../../../docs/delivery/adr/ADR-013-release-channel.md)

## Files this task may change

- `.github/workflows/release.yml`
- `package.json`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) | New | Manual dispatch with required tag input; always verifies one tarball, then publishes that exact artifact with provenance only when opted in. |
| [`package.json`](../../../package.json) | Edited | publishConfig and the version/omp.version pair the tag step asserts. |

## Steps

1. Expose only `workflow_dispatch`, with a required `tag` input and a boolean `publish` input defaulting false; checkout and the version gate use `inputs.tag`, and the gate asserts tag == package.json version == omp.version before publication is possible.
2. Always run version/changelog validation, patch hygiene, typecheck and fast suites through the pack lifecycle, the console suite, lint, delivery-doc drift checks, pack assertions, and the consumer-install smoke asserting the current RpcClient.pid state: 'pid absent, degraded supervision'.
3. Create one tarball, retain it as the verified artifact through every pack and consumer assertion, and publish that exact tarball only when `inputs.publish` is true.
4. Publish the verified tarball with `npm publish <tarball> --provenance`; the job declares `permissions: id-token: write`, and the manifest sets publishConfig.access to "public" for the scoped name.

## Acceptance

- [x] The workflow has only a manual `workflow_dispatch` trigger with required `tag` and boolean `publish` inputs; `publish` defaults false, while checkout and version validation use `inputs.tag`.
- [x] Every dispatch runs version/changelog validation, patch hygiene, typecheck and fast suites through the pack lifecycle, the console suite, lint, docs drift, pack assertions, and the consumer-install smoke with RpcClient.pid in the 'pid absent, degraded supervision' state.
- [x] The publish step runs only when `inputs.publish` is true, has `id-token: write`, and publishes public with `--provenance`.
- [x] Publication uses the same single tarball already exercised by pack assertions and the consumer-install smoke; no publish-time rebuild can change the artifact.

Evidence:

| Claim | Anchor |
|---|---|
| Commits 264207d and 0cf7d17 ship manual-only verification with explicit publication opt-in for one verified tarball | [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) |
| Commit 264207d supplies release lifecycle commands | `package.json §scripts` |

## Out of scope

- GitHub Releases notes beyond the changelog excerpt.

## Depends on

- T-1301
- T-1302
- T-1306

## Unblocks

- Nothing.
