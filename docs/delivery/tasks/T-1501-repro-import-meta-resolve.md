# T-1501 — Minimal repro: Bun.plugin memo-corruption of import.meta.resolve

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A minimal, self-contained repro of the legacy-pi-compat Bun.plugin onResolve hook memo-corrupting import.meta.resolve for @oh-my-pi/* — runnable upstream without our repo.

## Read first

- [The workaround this replaces](../../../src/worker/lifecycle.ts)
- [Worker lifecycle suite](../../../tests/worker-lifecycle.test.ts)

## Files this task may change

- `repro/bun-plugin-memo/README.md`
- `repro/bun-plugin-memo/repro.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `repro/bun-plugin-memo/README.md` (to be created) | New | Symptoms, root cause, affected versions, and the walk we do instead — written as the issue body. |
| `repro/bun-plugin-memo/repro.ts` (to be created) | New | The minimal failure: plugin installed, resolution corrupted under deterministic ordering; plugin removed, resolution correct. |

## Steps

1. Extract the failure from resolveOmpCli's history: the legacy-pi-compat onResolve hook memoizes across packages, so resolving a second @oh-my-pi/* package returns the first's resolution.
2. Make it minimal: one file, pinned deps, no daemon — run, observe the wrong resolution; remove the plugin, observe the correct one.
3. The README names the affected Bun and pi-coding-agent versions and links our workaround location.

## Acceptance

- [ ] The repro runs standalone and demonstrates the corruption deterministically.
- [ ] The README is the issue body, ready to paste.

## Out of scope

- Filing the issue (T-1502) and removing our workaround (T-1503).

## Depends on

- Nothing.

## Unblocks

- T-1502
