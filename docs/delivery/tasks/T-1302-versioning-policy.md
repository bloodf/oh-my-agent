# T-1302 — Semver policy and the changelog

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The repo has a written versioning policy and a changelog the release workflow consumes: semver semantics for a pre-1.0 plugin and the release-commit ritual.

## Read first

- [ADR-013: release channel](../../../docs/delivery/adr/ADR-013-release-channel.md)
- [Package manifest](../../../package.json)
- [README](../../../README.md)

## Files this task may change

- `CHANGELOG.md`
- `README.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `CHANGELOG.md` (to be created) | New | Keep-a-changelog format: the policy in a header paragraph, Unreleased on top. |
| [`README.md`](../../../README.md) | Edited | A one-paragraph pointer to the policy; the ritual lives in the changelog header. |

## Steps

1. CHANGELOG.md in keep-a-changelog format; the header states the policy (pre-1.0: minor is features, patch is fixes, breaking is minor until 1.0).
2. The ritual: version bump, changelog move from Unreleased, and tag in one commit; T-1303's workflow consumes the tag.
3. README gains a pointer paragraph and nothing more — one home for the policy.

## Acceptance

- [ ] CHANGELOG.md exists with the policy header and an Unreleased section.
- [ ] After a release, package.json's version matches the latest changelog entry.

## Out of scope

- The release workflow itself (T-1303).

## Depends on

- Nothing.

## Unblocks

- T-1303
