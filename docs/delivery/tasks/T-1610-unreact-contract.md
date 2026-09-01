# T-1610 — Unreact contract parity

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

chat_unreact mirrors chat_react by rejecting an unknown messageId as INVALID_PARAMS instead of silently succeeding.

## Read first

- [Reaction dispatch](../../../src/daemon/socket.ts)
- [Parallel react test](../../../tests/daemon-main.test.ts)

## Files this task may change

- `src/daemon/socket.ts`
- `tests/daemon-main.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Returns INVALID_PARAMS with messageId field data for unknown unreact targets. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | Reuses the parallel chat_react unknown-message pattern. |

## Steps

1. Route chat_unreact's unknown-message result through the same INVALID_PARAMS contract as chat_react.
2. Clone the behavior pattern, not implementation, from the parallel react test and assert data.field.

## Acceptance

- [ ] Unknown messageId returns INVALID_PARAMS with data.field === 'messageId'; the parallel react path's test pattern is reused.

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
