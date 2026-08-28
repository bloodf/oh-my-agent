# T-1001 — Serve the console from the daemon

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The daemon itself serves the console API and the client, behind an operator token — the browser UI has a backend to reach.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Console API](../../../src/daemon/console-api.ts)
- [Console guide](../../../docs/web-console.md)
- [Daemon entry point](../../../src/daemon/main.ts)

## Files this task may change

- `src/daemon/main.ts`
- `src/daemon/console-api.ts`
- `tests/daemon-console-mount.test.ts`
- `docs/web-console.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Boots the console server beside the control socket; token generation and storage; shutdown order. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Serves the client statics from `src/console/` on the same listener; the API routes are unchanged. |
| `tests/daemon-console-mount.test.ts` (to be created) | New | Boot → fetch the shell and the API with the token; restart reuses the stored token; shutdown releases the port. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | The 'Running it' section stops describing the future. |
| [`src/console/`](../../../src/console/) | Read | The client being served. |

## Steps

1. Generate the operator token at first boot (crypto random), store it mode-0600 under the state dir, and print the console URL once at startup. A stored token is reused on restart; rotating is deleting the file.
2. Mount `startConsoleApi` in `bootDaemon` on loopback with a configurable port (env override, default 0 = ephemeral and printed), and close it in the reverse-order shutdown before the store closes.
3. Serve `src/console/` statics at `/` on the same listener: index.html, app.js, style.css, with correct content types and no path traversal (resolve-and-contain, same standard as the peer-store write).
4. Everything off by default is wrong for the surface's purpose — but an env kill-switch (e.g. OMA_CONSOLE=0) keeps a daemon headless when wanted.

## Acceptance

- [ ] Booting the daemon serves the client at `/` and the API at `/api/*` on one loopback listener.
- [ ] The printed URL works in a browser; a request without the token is 401.
- [ ] A restart keeps the same token; the token file is mode 0600.
- [ ] Shutdown frees the port and a second boot binds cleanly.

## Out of scope

- Binding beyond loopback, which is what T-1004 is for.

## Depends on

- T-602
- T-603

## Unblocks

- Nothing.
