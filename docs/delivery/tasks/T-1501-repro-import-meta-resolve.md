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
- `repro/bun-plugin-memo/package.json`
- `repro/bun-plugin-memo/bun.lock`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`repro/bun-plugin-memo/README.md`](../../../repro/bun-plugin-memo/README.md) | New | The fixed issue-body structure: symptoms, observed resolutions, affected versions, expected vs actual, repro command — plus the walk we do instead. |
| [`repro/bun-plugin-memo/package.json`](../../../repro/bun-plugin-memo/package.json) | New | Declares `"dependencies": { "@oh-my-pi/pi-coding-agent": "18.0.7" }`, `"scripts": { "repro": "bun repro.ts" }`, and `"packageManager": "bun@1.3.14"`; packageManager is expected-runtime metadata rather than a universal runtime selector. |
| [`repro/bun-plugin-memo/repro.ts`](../../../repro/bun-plugin-memo/repro.ts) | New | The minimal failure: N/N corrupted resolutions with the plugin installed, N/N correct with it removed, output captured for the record. |
| [`repro/bun-plugin-memo/bun.lock`](../../../repro/bun-plugin-memo/bun.lock) | New | Pins dependency resolution from package.json; it does not pin or select the Bun executable/runtime. |

## Steps

1. Reproduce the failure resolveOmpCli works around: with the plugin installed, capture the observed resolution output; with it removed, capture again. Derive the mechanism from that evidence — the earlier cross-package-memoization theory is falsified by upstream's per-specifier cache key (legacy-pi-compat.ts ~1127-1135) and by our own workaround comment (lifecycle.ts ~112-121), so the repro asserts observations, not a story.
2. Make it minimal: one repro.ts execution file, exact @oh-my-pi/pi-coding-agent 18.0.7 dependency, locked dependency resolution, and no daemon. Run N consecutive resolutions with the plugin installed and N with it removed, recording every result. The control is part of the design: a hand-written minimal Bun.plugin onResolve hook with no OMP installed either reproduces the corruption or doesn't, and that outcome decides which tracker the issue goes to. package.json records packageManager bun@1.3.14 only as expected-runtime metadata; repro.ts prints Bun.version and exits non-zero before installing hooks unless it is exactly 1.3.14.
3. The README follows the fixed issue-body structure: symptoms, observed resolutions, affected versions, expected vs actual, and repro command. It names the affected Bun and pi-coding-agent versions, links our workaround location, and shows the official exact-version install command `curl -fsSL https://bun.com/install | bash -s "bun-v1.3.14"`, followed by `bun install --frozen-lockfile` and `bun run repro`.

## Acceptance

- [ ] The repro prints Bun.version and refuses to run on any runtime version other than exactly 1.3.14.
- [ ] The repro fails N/N consecutive runs with the plugin installed and passes N/N with it removed.
- [ ] A hand-written minimal Bun.plugin onResolve hook with no OMP installed either reproduces the corruption or doesn't. package.json pins @oh-my-pi/pi-coding-agent to exactly 18.0.7, and committed bun.lock pins the resulting dependency resolution; neither packageManager metadata nor bun.lock selects or pins the Bun executable/runtime. The control result determines whether the issue goes to oven-sh/bun or oh-my-pi.
- [ ] The repro names its public hosting (this repo is public — the in-tree repro/ path) and its README carries an MIT license line.
- [ ] The README is the issue body with a fixed structure: symptoms, observed resolutions, affected versions, expected vs actual, and repro command. Its commands install Bun 1.3.14 with the official exact-version installer, run `bun install --frozen-lockfile`, then run `bun run repro`.

## Out of scope

- Filing the issue (T-1502) and removing our workaround (T-1503).

## Depends on

- Nothing.

## Unblocks

- T-1502
