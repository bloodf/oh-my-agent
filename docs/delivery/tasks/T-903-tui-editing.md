# T-903 — Definition and model editing flows

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-09](../epics/EP-09-tui-management.md) | [SP-10](../sprints/SP-10-tui-management.md) | Ready | [asset-map](../asset-map.md) |

## Goal

An operator edits an agent's definition and model in guided dialogs, and the change persists and takes effect.

## Read first

- [Commands](../../../src/extension/commands.ts)
- [OMP editor/select dialog API](../../../node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts)

## Files this task may change

- `src/extension/commands.ts`
- `src/extension/manager.ts`
- `tests/extension.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | `/edit <name>` flows: definition via pre-filled editor, model via selection over configured roles. |
| [`src/extension/manager.ts`](../../../src/extension/manager.ts) | Edited | The manager's edit actions call the same flows. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | Edit round trips against the real socket: get → edit → update → staleness handoff. |

## Steps

1. `definition_get` → `ctx.ui.editor` with the current document pre-filled → `definition_update` on submit; a parser refusal redisplays the editor with the error, because losing an operator's edit to a validation throw is how dialogs get hated.
2. Model editing is a `select` over the configured model roles plus free input; the change persists through `definition_update` and takes effect via the T-505 rebuild on next delivery.
3. Assert the handoff: an edited definition reports `rebuildRequired` and the next delivery rebuilds (the daemon suite's T-505 path, driven from the extension suite).

## Acceptance

- [ ] An edited definition persists to the store and reparses; a refused edit loses no input.
- [ ] A model change is reflected in the worker's next session without a daemon restart.
- [ ] Both flows are reachable from `/edit` and from the manager.

## Out of scope

- Spawning new agents from the editor, which `/spawn` and T-901 cover.

## Depends on

- T-801
- T-901

## Unblocks

- Nothing.
