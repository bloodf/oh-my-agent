# T-703 — Root README and package metadata

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-07](../epics/EP-07-release-readiness.md) | [SP-08](../sprints/SP-08-release-readiness.md) | Done | [asset-map](../asset-map.md) |

## Goal

A stranger landing on the repository can tell what it is, install it, and find the delivery tree.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Delivery tree](../../../docs/delivery/README.md)
- [License decision](../../../docs/delivery/adr/ADR-010-mit-license.md)

## Files this task may change

- `README.md`
- `package.json`
- `LICENSE`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`README.md`](../../../README.md) | New | Front door: what, install, run, where to read next. |
| [`package.json`](../../../package.json) | Edited | `repository`, `homepage`, `bugs`, `keywords`, `engines`, `license`. |
| [`LICENSE`](../../../LICENSE) | New | MIT text; lands in the same change as the `license` field (ADR-010). |
| [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) | Read | The design document the README points at, not duplicates. |

## Steps

1. State in the first paragraph what the plugin does and what state it is in. A README that oversells an unfinished operator surface costs more trust than it buys.
2. Give install and run instructions that were actually executed, not inferred from the manifest.
3. Link onward: `ARCHITECTURE.md` for the design, `docs/delivery/` for the work. Do not restate either, because a third copy of the same claims is a third thing to keep true.
4. Add `repository`, `homepage`, `bugs`, `keywords`, and `engines` with `bun >=1.3.14` to the manifest.
5. Add the MIT `LICENSE` file and `license: "MIT"` together, per ADR-010: a field with no text asserts a grant nobody made, and text with no field is invisible to tooling.

## Acceptance

- [x] The README's install and run commands were run as written and worked.
- [x] `package.json` carries repository, homepage, bugs, keywords, and an `engines.bun` constraint.
- [x] `package.json` carries `license: "MIT"` and the MIT text exists at `LICENSE`, matching ADR-010.
- [x] Every link in the README resolves.

Evidence:

| Claim | Anchor |
|---|---|
| Root README | [`./README.md`](../../.././README.md) |
| Package metadata | [`./package.json`](../../.././package.json) |
| MIT license text | [`./LICENSE`](../../.././LICENSE) |

## Out of scope

- Badges pointing at CI, which are worth adding only once T-701's workflow has run green at least once.

## Depends on

- Nothing.

## Unblocks

- Nothing.
