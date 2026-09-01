# T-1304 — README install path for the released artifact

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

The README's install path installs the released package into OMP and reaches a running daemon in five commands — not a repo build.

## Read first

- [README](../../../README.md)
- [Package manifest](../../../package.json)

## Files this task may change

- `README.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`README.md`](../../../README.md) | Edited | Install and quickstart rewritten against the released artifact; the checkout-build path moves to a development section. |

## Steps

1. Install: add the package, OMP picks up the extension, first daemon boot.
2. Verify: `omp-agent status` answers and the console opens.
3. Move the build-from-checkout instructions under Development.

## Acceptance

- [ ] The quickstart's commands are executed against the packed artifact by T-1306's consumer smoke test.

## Out of scope

- The release pipeline (T-1303).

## Depends on

- T-1301
- T-1306

## Unblocks

- Nothing.
