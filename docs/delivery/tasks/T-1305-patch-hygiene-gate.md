# T-1305 — patches/ contains code only, enforced

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Done | [asset-map](../asset-map.md) |

## Goal

CI proves every file under patches/ is a code-only patch whose pin matches the lockfile: no binary hunks, no stray files, no hunks touching non-source paths, no stale patch keys — the .DS_Store incident becomes a gate.

## Read first

- [The one patch under contract](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch)
- [CI workflow](../../../.github/workflows/ci.yml)

## Files this task may change

- `scripts/check-patches.py`
- `.github/workflows/ci.yml`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`scripts/check-patches.py`](../../../scripts/check-patches.py) | New | Parses unified diffs under patches/; fails on binary hunks, non-patch files, hunks outside source paths, and patch keys that decode (%2F) to no patchedDependencies entry or a stale version; has a --selftest fixture mode. |
| [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | Edited | Runs the gate alongside the existing gates. |

## Steps

1. Parse each patch: every hunk must name a source path in the package; GIT binary hunks and literal/delta content fail.
2. Fail on any non-.patch file in patches/.
3. Match every patch filename: it decodes (%2F) to a key in patchedDependencies, and the pinned version equals the lockfile-resolved version of that package — a stale pin fails.
4. Wire into CI; --selftest proves the gate fails on a fixture containing a binary hunk.

## Acceptance

- [x] The gate passes on the current patch and fails on a binary-hunk fixture under --selftest.
- [x] Each patch filename decodes (%2F) to a patchedDependencies key that matches the lockfile-resolved version.
- [x] CI runs both the gate and its selftest.

Evidence:

| Claim | Anchor |
|---|---|
| Commit 3c3f611 adds the patch hygiene gate, which passes today | [`scripts/check-patches.py`](../../../scripts/check-patches.py) |
| Commit 3c3f611 runs the patch hygiene gate in CI | [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) |

## Out of scope

- Removing the patch (T-1504).

## Depends on

- Nothing.

## Unblocks

- Nothing.
