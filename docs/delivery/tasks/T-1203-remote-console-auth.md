# T-1203 — Operator-token flow in the console client

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

The console client authenticates as the operator over the wire: a first-visit token prompt, reload persistence, a clear refusal state — and no prompt at all on loopback.

## Read first

- [Console client](../../../src/console/app.js)
- [Console API](../../../src/daemon/console-api.ts)
- [Browser suite](../../../tests/console-client.test.ts)

## Files this task may change

- `src/console/app.js`
- `src/console/index.html`
- `src/daemon/console-api.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Token entry flow, the token on every fetch and the WebSocket upgrade, a 401 state with re-entry. |
| [`src/console/index.html`](../../../src/console/index.html) | Edited | The token prompt markup: semantic, labeled, keyboard-first. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Token verification on every request in remote mode; the 401 shape the client renders. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proven: prompt, success, refusal, reload persistence. |

## Steps

1. Daemon side first: the remote-mode 401 shape, then the client renders it as a labeled prompt using the T-1101/T-1102 landmarks and focus model.
2. Persist the token in sessionStorage (an operator surface is not a remember-me app) and send it on every request, including the WebSocket upgrade.
3. The client learns the mode from the daemon's first response, not from configuration; loopback never shows the prompt.

## Acceptance

- [ ] The browser suite drives: first visit shows the prompt, a good token opens the console, reload with the stored token opens directly, a bad token shows the refusal state with re-entry.
- [ ] The WebSocket carries the token; an unauthenticated upgrade is refused in remote mode.
- [ ] Loopback flows show no prompt and pass unchanged.

## Out of scope

- Multi-user accounts or sessions; one operator token, per ADR-012.

## Depends on

- T-1202

## Unblocks

- Nothing.
