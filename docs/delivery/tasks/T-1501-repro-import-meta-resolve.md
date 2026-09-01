# T-1501 — Minimal repro: Bun.plugin corruption of import.meta.resolve

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A minimal, self-contained repro of the legacy-pi-compat Bun.plugin onResolve hook corrupting import.meta.resolve for @oh-my-pi/* — mechanism derived from observed output, not asserted — runnable upstream without our repo.

## Read first

- [The workaround this replaces](../../../src/worker/lifecycle.ts)
- [Worker lifecycle suite](../../../tests/worker-lifecycle.test.ts)
- [The per-specifier cache key that falsified the memo theory](../../../node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/legacy-pi-compat.ts)

## Files this task may change

- `repro/bun-plugin-memo/README.md`
- `repro/bun-plugin-memo/repro.ts`
- `repro/bun-plugin-memo/bun.lock`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `repro/bun-plugin-memo/README.md` (to be created) | New | The fixed issue-body structure: symptoms, observed resolutions, affected versions, expected vs actual, repro command — plus the walk we do instead. |
| `repro/bun-plugin-memo/repro.ts` (to be created) | New | The minimal failure: N/N corrupted resolutions with the plugin installed, N/N correct with it removed, output captured for the record. |
| `repro/bun-plugin-memo/bun.lock` (to be created) | New | Pins the repro's Bun version; the filing-target control runs against exactly this toolchain. |

## Steps

1. Reproduce the failure resolveOmpCli works around: with the plugin installed, capture the observed resolution output; with it removed, capture again. Derive the mechanism from that evidence — the earlier cross-package-memoization theory is falsified by upstream's per-specifier cache key (legacy-pi-compat.ts ~1127-1135) and by our own workaround comment (lifecycle.ts ~112-121), so the repro asserts observations, not a story.
2. Make it minimal: one file, pinned deps, no daemon — N consecutive runs with the plugin installed, N with it removed, every resolution recorded. The control is part of the design: a hand-written minimal Bun.plugin onResolve hook with no OMP installed either reproduces the corruption or doesn't, and that outcome decides which tracker the issue goes to.
3. The README follows the fixed issue-body structure — symptoms, observed resolutions, affected versions, expected vs actual, repro command — names the affected Bun and pi-coding-agent versions, and links our workaround location.

## Acceptance

- [ ] The repro fails N/N consecutive runs with the plugin installed and passes N/N with it removed.
- [ ] A hand-written minimal Bun.plugin onResolve hook with no OMP installed either reproduces the corruption or doesn't, and the repro dir pins its Bun version (committed bun.lock) — the result determines whether the issue goes to oven-sh/bun or oh-my-pi.
- [ ] The repro names its public hosting (this repo is public — the in-tree repro/ path) and its README carries an MIT license line.
- [ ] The README is the issue body with a fixed structure: symptoms, observed resolutions, affected versions, expected vs actual, repro command.

## Out of scope

- Filing the issue (T-1502) and removing our workaround (T-1503).

## Depends on

- Nothing.

## Unblocks

- T-1502
