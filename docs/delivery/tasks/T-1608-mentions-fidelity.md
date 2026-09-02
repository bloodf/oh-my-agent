# T-1608 — Mention fidelity on every surface

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Mentions reach every consumer through the shared RoomMessage wire type and render distinctly in the console.

## Read first

- [RoomMessage wire type](../../../src/shared/protocol.ts)
- [Protocol schemas](../../../src/shared/protocol-schemas.ts)
- [Protocol contract suite](../../../tests/protocol.contract.test.ts)
- [Console message renderer](../../../src/console/app.js)

## Files this task may change

- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `src/console/app.js`
- `src/console/style.css`
- `tests/protocol.contract.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | Adds mentions to the additive RoomMessage wire type. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Validates mentions on RoomMessage frames. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Carries stored mentions onto the wire. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Adds the browser typedef and mention-aware rendering. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Provides the distinct mention affordance. |
| [`tests/protocol.contract.test.ts`](../../../tests/protocol.contract.test.ts) | Edited | Asserts mentions in the wire shape. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proves a mention of @agent renders distinctly. |

## Steps

1. Add mentions to the shared RoomMessage type and schema, then preserve it through socket serialization.
2. Mirror the field in the browser typedef and render mention tokens with a distinct affordance.
3. Assert the wire shape in the protocol contract and the rendered behavior in the browser suite.

## Acceptance

- [x] The contract suite asserts mentions on the wire shape.
- [x] Browser-proven: a message mentioning @agent renders the mention affordance.

Evidence:

| Claim | Anchor |
|---|---|
| mentions on the wire and rendered in the console | [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) |
| Commit | `f31ae27` |

## Out of scope

- Mention autocomplete in the composer.

## Depends on

- Nothing.

## Unblocks

- Nothing.
