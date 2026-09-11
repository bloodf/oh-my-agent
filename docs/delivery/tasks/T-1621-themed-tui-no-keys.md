# T-1621 — The TUI renders through the OMP theme and binds no keys

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

The status widget and the manager overlay draw with the theme and symbol preset the operator chose in OMP, and the plugin registers no keybinding: every surface is a slash command, so nothing collides with a binding the operator or another extension owns.

## Read first

- [The widget line and its refresh](../../../src/extension/widget.ts)
- [The manager overlay's render modes](../../../src/extension/manager.ts)
- [The extension entry point and its command registrations](../../../src/extension/index.ts)

## Files this task may change

- `src/extension/theme.ts`
- `src/extension/widget.ts`
- `src/extension/manager.ts`
- `src/extension/commands.ts`
- `src/extension/index.ts`
- `tests/extension.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/extension/theme.ts`](../../../src/extension/theme.ts) | New | The slice of OMP's Theme the surfaces need, a plain fallback, and the adapter that degrades to it. |
| [`src/extension/widget.ts`](../../../src/extension/widget.ts) | Edited | The widget is a themed renderer: colors per state, the preset's separator, and a /manage hint. |
| [`src/extension/manager.ts`](../../../src/extension/manager.ts) | Edited | Titles, cursor, status marks, and key hints render through the host's theme; the factory no longer ignores it. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | ExtensionIO.setWidget accepts a themed renderer as well as lines. |
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | The Alt+G registration is removed; a renderer becomes OMP's component factory. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | A tagging theme proves each segment's color and symbol; the adapter's fallback is pinned. |

## Steps

1. Define the theme slice structurally, so OMP's Theme satisfies it without an import and a host that passes nothing renders plain text.
2. Route every string the widget and the overlay draw through that slice: fg for state and hints, the preset's cursor, status marks, and separator.
3. Delete the shortcut registration and name /manage in the widget hint and the docs.

## Acceptance

- [x] The widget and the overlay render through a tagging theme with every segment attributed to a color and the preset's symbols in place of the hardcoded ones.
- [x] A host that passes no theme renders the same text uncolored.
- [x] No registerShortcut call remains, and no doc names Alt+G as a live binding.

Evidence:

| Claim | Anchor |
|---|---|
| Widget and overlay render through the host's theme; themeFrom falls back to plain text | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |

## Out of scope

- Theming the console: it has its own palette and is not drawn by OMP.

## Depends on

- T-1619

## Unblocks

- Nothing.
