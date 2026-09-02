# T-1607 — Definition authoring parity

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

CLI agent create/show/edit verbs and console definition read/edit complete definition-authoring parity over existing protocol methods.

## Read first

- [CLI command surface](../../../src/daemon/cli.ts)
- [Definition API routes](../../../src/daemon/console-api.ts)
- [Console definition UI](../../../src/console/app.js)

## Files this task may change

- `src/daemon/cli.ts`
- `src/daemon/console-api.ts`
- `src/console/app.js`
- `src/console/index.html`
- `src/console/style.css`
- `tests/daemon-cli.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | Adds agent create/show/edit over agent_create, definition_get, and definition_update. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Adds definition read beside the existing PATCH route. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Loads, edits, saves, and renders strict-parser errors inline. |
| [`src/console/index.html`](../../../src/console/index.html) | Edited | Adds the semantic definition editor surface. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Token-only editor rules for the definition dialog. |
| [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) | Edited | Round-trips all three verbs against a real daemon. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proves definition edit and bad-key errors. |

## Steps

1. Map agent create/show/edit directly to agent_create, definition_get, and definition_update with existing CLI error conventions.
2. Add a definition read route and an editor that consumes the existing PATCH path; keep strict parser errors inline.
3. Round-trip the CLI against a real daemon and browser-prove valid edits plus a bad-key failure.

## Acceptance

- [x] The three CLI verbs round-trip against a real daemon with clean errors.
- [x] Browser-proven: edit a definition in the console and the strict parser's error renders inline on a bad key.

Evidence:

| Claim | Anchor |
|---|---|
| agent create/show/edit verbs + console definition editor with inline parser errors | [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) |
| Commit | `cf59131` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
