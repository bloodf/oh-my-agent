# T-1303 — Tag-driven release workflow

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

A pushed tag runs the full gate suite and the pack test, then publishes the npm artifact — with ADR-013's patch-travel decision implemented as a pipeline step, not a wiki note.

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
| `.github/workflows/release.yml` (to be created) | New | Tag-triggered: install, gates, pack test, publish with provenance. |
| [`package.json`](../../../package.json) | Edited | publishConfig and the version the tag step asserts. |

## Steps

1. Trigger on v* tags; a step asserts the tag version equals package.json's version before anything publishes.
2. Run the full suite, the delivery-doc gates, and the pack test on the tag checkout.
3. Publish with provenance; the patch-travel step either applies patches/ at pack time or asserts the patch is gone (T-1503 Done).

## Acceptance

- [ ] A tag whose version mismatches package.json fails before publish.
- [ ] A workflow_dispatch dry-run mode exercises everything except the publish step.

## Out of scope

- GitHub Releases notes beyond the changelog excerpt.

## Depends on

- T-1301
- T-1302

## Unblocks

- Nothing.
