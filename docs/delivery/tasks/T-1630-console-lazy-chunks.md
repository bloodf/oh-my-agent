# T-1630 — A small console bundle: lazy chunks, gzip, immutable caching

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

The console's first load is under a megabyte again: mermaid and its diagram packs are content-hashed chunks fetched only when a diagram renders, served immutable and gzipped, with the daemon still serving an allowlist of shapes and remote mode still gating every asset behind a ticket.

## Read first

- [The static allowlist and ticket gate](../../../src/daemon/console-api.ts)
- [The build that names the output](../../../web/vite.config.ts)

## Files this task may change

- `web/vite.config.ts`
- `web/src/main.tsx`
- `src/daemon/console-api.ts`
- `src/console/app.js`
- `src/console/style.css`
- `tests/daemon-console-mount.test.ts`
- `tests/remote-exposure.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`web/vite.config.ts`](../../../web/vite.config.ts) | Edited | Hashed chunk names and a runtime URL minter for dynamic imports. |
| [`web/src/main.tsx`](../../../web/src/main.tsx) | Edited | A default minter for the dev server. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Chunk shape in the allowlist, immutable caching, gzip with an mtime-keyed cache, the injected minter, and a reusable prefix-bound chunk pass in remote mode. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Rebuilt, under a megabyte. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Rebuilt. |
| [`tests/daemon-console-mount.test.ts`](../../../tests/daemon-console-mount.test.ts) | Edited | A chunk exists and app.js is small; a chunk is served immutable and gzipped with the token-minted URL; a chunk never built is 404. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | Edited | The remote shell carries a chunk pass that serves a chunk twice and nothing else. |

## Steps

1. Let the build emit chunks under one recognizable shape and mint their URLs at runtime through an injected function.
2. Serve that shape with immutable caching and gzip, and keep everything else under the fixed allowlist.
3. In remote mode, mint one reusable pass bound to the chunk prefix into the shell, since one-time tickets cannot cover a chunk fetched an hour later.

## Acceptance

- [x] app.js is under 1.5 MB and a mermaid chunk exists beside it.
- [x] A chunk answers 200 with immutable caching, gzipped when accepted, 401 without a credential, and a chunk that was never built is 404.
- [x] In remote mode the pass serves a chunk repeatedly and is refused for app.js.

Evidence:

| Claim | Anchor |
|---|---|
| Chunk serving on loopback | [`tests/daemon-console-mount.test.ts`](../../../tests/daemon-console-mount.test.ts) |
| The chunk pass in remote mode | [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) |
| Mermaid still renders from a lazy chunk | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Brotli: gzip is what Bun ships without a dependency and is enough on loopback and behind a proxy that can recompress.

## Depends on

- T-1629

## Unblocks

- Nothing.
