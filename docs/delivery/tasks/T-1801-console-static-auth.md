# T-1801 — The console reloads and loads lazy chunks on a real daemon

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-18](../epics/EP-18-review-2026-09.md) | [SP-19](../sprints/SP-19-review-fixes.md) | Done | [asset-map](../asset-map.md) |

## Goal

A loopback console survives a reload and renders Mermaid on a real daemon. Static files authenticate with a per-port HttpOnly SameSite=Strict cookie that holds an HMAC of the operator token on loopback and the asset pass in remote mode, and that cookie opens static files only. The browser suite loads the console through the daemon's own static path, so a static-auth regression fails CI.

## Read first

- [The review findings Q-01, Q-02, and G-01](../../../docs/develop/review-2026-09.md)
- [Static serving and auth](../../../src/daemon/console-api.ts)

## Files this task may change

- `src/daemon/console-api.ts`
- `web/src/lib/api.ts`
- `web/src/lib/token.ts`
- `web/src/lib/attachments.ts`
- `web/src/main.tsx`
- `web/vite.config.ts`
- `web/src/console/useConsole.ts`
- `web/src/console/ConsoleShell.tsx`
- `web/src/console/AuthScreen.tsx`
- `tests/console-client.test.ts`
- `tests/console-api-client.test.ts`
- `tests/daemon-console-mount.test.ts`
- `tests/remote-exposure.test.ts`
- `docs/web-console.md`
- `docs/guide/console.md`
- `docs/remote-exposure.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Static cookie minted on token-bearing document loads and accepted for static files only; bare app.js; no token stamping. |
| [`web/src/lib/api.ts`](../../../web/src/lib/api.ts) | Edited | ApiError with code and status; non-JSON and empty bodies; 401 is auth-required in both modes. |
| [`web/src/lib/token.ts`](../../../web/src/lib/token.ts) | New | readToken, moved out so api.ts is unit-testable. |
| [`web/src/lib/attachments.ts`](../../../web/src/lib/attachments.ts) | Edited | Upload and delete 401s go through the shared revoke path. |
| [`web/src/main.tsx`](../../../web/src/main.tsx) | Edited | Drops the __omaAsset helper. |
| [`web/vite.config.ts`](../../../web/vite.config.ts) | Edited | No renderBuiltUrl; the dev proxy finds the daemon and forwards the WebSocket with a matching Origin. |
| [`web/src/console/useConsole.ts`](../../../web/src/console/useConsole.ts) | Edited | A shared revoke handler for refused tokens. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | Passes the revoke handler. |
| [`web/src/console/AuthScreen.tsx`](../../../web/src/console/AuthScreen.tsx) | Edited | Wording for a refused loopback token. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Loopback static requests go through the real daemon; reload, Mermaid, refused-token, and remote Mermaid tests. |
| [`tests/console-api-client.test.ts`](../../../tests/console-api-client.test.ts) | New | Unit tests for api() status, code, and body handling. |
| [`tests/daemon-console-mount.test.ts`](../../../tests/daemon-console-mount.test.ts) | Edited | Static cookie scope and HMAC tests. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | Edited | Remote asset-pass cookie tests. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | Static cookie auth. |
| [`docs/guide/console.md`](../../../docs/guide/console.md) | Edited | Reload and dev-proxy behaviour. |
| [`docs/remote-exposure.md`](../../../docs/remote-exposure.md) | Edited | Asset pass travels in a Secure cookie. |

## Steps

1. Replace token stamping with a static-only cookie on loopback and in remote mode.
2. Serve the browser suite's console through the daemon's static path.
3. Make api() errors carry the daemon's code and status.

## Acceptance

- [x] A reload of a loopback console renders the console, and no URL carries the token.
- [x] A Mermaid fence renders on a real daemon in loopback and remote mode.
- [x] The static cookie never authenticates /api or the WebSocket.

Evidence:

| Claim | Anchor |
|---|---|
| Reload, Mermaid, and refused-token browser tests through the daemon | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
| Cookie scope tests | [`tests/daemon-console-mount.test.ts`](../../../tests/daemon-console-mount.test.ts) |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-1805
