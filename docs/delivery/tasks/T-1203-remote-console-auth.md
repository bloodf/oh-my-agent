# T-1203 — Operator-token flow in the console client

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Done | [asset-map](../asset-map.md) |

## Goal

The console client authenticates as the operator over the wire: a first-visit token prompt, reload persistence, a clear refusal state — and no prompt at all on loopback. In remote mode the long-lived token never rides a URL.

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
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Token entry flow, the token on every API fetch, one-time tickets for the WebSocket upgrade and static loads, and a 401 state with re-entry. |
| [`src/console/index.html`](../../../src/console/index.html) | Edited | The token prompt markup: semantic, labeled, keyboard-first. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Token verification on remote `/api/*` requests, including the two ticket-mint endpoints; the 401 shape the client renders; and path-bound, single-use tickets for the WebSocket upgrade and static loads, expiring after 30 seconds. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proven: prompt, success, refusal, reload persistence, no token in any URL. |

## Steps

1. Daemon side first: the remote-mode 401 shape, then the client renders it as a labeled prompt using the T-1101/T-1102 landmarks and focus model.
2. Persist the token in sessionStorage (an operator surface is not a remember-me app) and send it as a header on every API fetch; the WebSocket upgrade and static loads authenticate with path-bound, single-use tickets minted only after operator-token authentication and expiring after 30 seconds — no `?token=` material in remote mode.
3. The client learns the mode from the daemon's first response, not from configuration; loopback never shows the prompt.

## Acceptance

- [x] The browser suite drives: first visit shows the prompt, a good token opens the console, reload with the stored token opens directly, a bad token shows the refusal state with re-entry.
- [x] The WebSocket upgrade and static loads authenticate with path-bound, single-use tickets minted only after operator-token authentication and expiring after 30 seconds — no operator token in any URL; an unauthenticated upgrade is refused in remote mode.
- [x] The token prompt and refusal state pass the console's existing accessibility assertions and are driven keyboard-only in the browser suite.
- [x] Loopback flows show no prompt and pass unchanged.

Evidence:

| Claim | Anchor |
|---|---|
| Commit ede50c4 ships the semantic keyboard-first operator-token login and refusal surface | [`src/console/index.html`](../../../src/console/index.html) |
| Commit ede50c4 persists remote operator credentials for the session and supports revocation without putting tokens in URLs | [`src/console/app.js`](../../../src/console/app.js) |
| Commit ede50c4 browser-proves login, reload persistence, refusal, revocation, and unchanged loopback behavior | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Multi-user accounts or sessions; one operator token, per ADR-012.

## Depends on

- T-1201

## Unblocks

- Nothing.
