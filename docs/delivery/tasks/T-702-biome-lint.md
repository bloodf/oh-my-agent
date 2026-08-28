# T-702 — Biome lint and format configuration

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-07](../epics/EP-07-release-readiness.md) | [SP-08](../sprints/SP-08-release-readiness.md) | Done | [asset-map](../asset-map.md) |

## Goal

The repository has one enforced style, checkable in one command.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Package manifest](../../../package.json)

## Files this task may change

- `biome.json`
- `package.json`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`biome.json`](../../../biome.json) | New | Lint and format rules. |
| [`package.json`](../../../package.json) | Edited | Adds `lint` and `format` scripts. |

## Steps

1. Configure Biome for the TypeScript sources and the test tree, excluding `node_modules` and any generated output.
2. Add `lint` (check, no writes) and `format` (write) scripts, so CI and a developer run the same tool with different intent rather than two tools.
3. Run the one-time normalization as its own separate change, before or after this one but never inside it: a formatting sweep mixed into a config commit makes both unreviewable.
4. Keep the rule set close to Biome's recommended defaults. A bespoke rule set is a standing argument, and the value here is uniformity, not opinion.

## Acceptance

- [x] `bun run lint` exits non-zero on a deliberately misformatted file and zero on the normalized tree.
- [x] `bun run format` is idempotent: running it twice produces no second diff.
- [x] The config excludes generated and vendored paths, so a clean tree is genuinely clean.

Evidence:

| Claim | Anchor |
|---|---|
| Biome configuration | [`./biome.json`](../../.././biome.json) |
| Lint and format scripts | [`./package.json`](../../.././package.json) |

## Out of scope

- Changing rule severities: the baseline keeps Biome's recommended preset, with one documented suppression (the NUL-matching sandbox regex).

## Depends on

- Nothing.

## Unblocks

- Nothing.
