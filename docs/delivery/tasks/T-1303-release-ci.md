# T-1303 — Tag-driven release workflow

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

A pushed tag runs the full gate suite and the pack test, then publishes the npm artifact — with ADR-013's pid-contract state asserted as a pipeline step, not a wiki note.

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
| `.github/workflows/release.yml` (to be created) | New | Tag-triggered: install, gates, pack test, publish with provenance, pid-contract assert. |
| [`package.json`](../../../package.json) | Edited | publishConfig and the version/omp.version pair the tag step asserts. |

## Steps

1. Trigger on v* tags; a step asserts tag == package.json version == omp.version before anything publishes.
2. Run the full suite, the delivery-doc gates, and the pack test on the tag checkout.
3. Publish with the pinned command `npm publish --provenance`: the job declares `permissions: id-token: write`, the manifest sets publishConfig.access to "public" for the scoped name, and the token policy is an npm automation token, not interactive 2FA.
4. The pack/publish step asserts the RpcClient.pid contract state of the resolved peer per amended ADR-013 — 'pid absent, degraded supervision' until T-1504 lands, 'pid present' after — so the patch story never drifts silently.

## Acceptance

- [ ] A tag that mismatches package.json's version or omp.version fails before publish.
- [ ] The publish job has id-token: write and publishes public.
- [ ] The pack/publish step asserts the pid contract state per amended ADR-013 (no silent patch-story drift).
- [ ] A workflow_dispatch dry-run mode exercises everything except the publish step.

## Out of scope

- GitHub Releases notes beyond the changelog excerpt.

## Depends on

- T-1301
- T-1302
- T-1306

## Unblocks

- Nothing.
