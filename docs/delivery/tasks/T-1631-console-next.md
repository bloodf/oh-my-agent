# T-1631 — A server-rendered console on Next.js

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

A Next.js app renders the console on the server: pages fetch the daemon with the operator token held server-side, the browser talks only to the Next origin through a proxy and a server-sent event stream, and Markdown arrives as HTML so a page without diagrams ships no mermaid. It runs beside the bundled console, builds and starts in the full suite against a real daemon, and stays out of the npm package.

## Read first

- [The decision](../../../docs/delivery/adr/ADR-016-server-rendered-console.md)
- [The daemon's console API the pages fetch](../../../src/daemon/console-api.ts)
- [The bundled console's Markdown renderer this mirrors](../../../web/src/console/Markdown.tsx)

## Files this task may change

- `web-next/package.json`
- `web-next/bun.lock`
- `web-next/next.config.ts`
- `web-next/tsconfig.json`
- `web-next/postcss.config.mjs`
- `web-next/README.md`
- `web-next/src/lib/daemon.ts`
- `web-next/src/lib/types.ts`
- `web-next/src/app/globals.css`
- `web-next/src/app/layout.tsx`
- `web-next/src/app/page.tsx`
- `web-next/src/app/error.tsx`
- `web-next/src/app/rooms/[id]/page.tsx`
- `web-next/src/app/rooms/[id]/plans/page.tsx`
- `web-next/src/app/agents/page.tsx`
- `web-next/src/app/artifacts/page.tsx`
- `web-next/src/app/api/[...path]/route.ts`
- `web-next/src/app/api/live/route.ts`
- `web-next/src/components/Markdown.tsx`
- `web-next/src/components/Mermaid.tsx`
- `web-next/src/components/Live.tsx`
- `web-next/src/components/Composer.tsx`
- `web-next/src/components/Reactions.tsx`
- `web-next/src/components/Action.tsx`
- `package.json`
- `tsconfig.json`
- `biome.json`
- `.gitignore`
- `.github/workflows/ci.yml`
- `tests/console-next.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`web-next/package.json`](../../../web-next/package.json) | New | next, react, react-markdown, remark-gfm, mermaid; dev, build, start on 4388, typecheck. |
| [`web-next/bun.lock`](../../../web-next/bun.lock) | New | Locked. |
| [`web-next/next.config.ts`](../../../web-next/next.config.ts) | New | Strict mode, no powered-by header, the app as its own workspace root. |
| [`web-next/tsconfig.json`](../../../web-next/tsconfig.json) | New | Next's defaults. |
| [`web-next/postcss.config.mjs`](../../../web-next/postcss.config.mjs) | New | Tailwind v4. |
| [`web-next/README.md`](../../../web-next/README.md) | New | How to run it and where it finds the daemon. |
| [`web-next/src/lib/daemon.ts`](../../../web-next/src/lib/daemon.ts) | New | Resolves the daemon from console-url or OMA_CONSOLE_URL; server-only fetch with the token. |
| [`web-next/src/lib/types.ts`](../../../web-next/src/lib/types.ts) | New | Wire shapes and personaFor. |
| [`web-next/src/app/globals.css`](../../../web-next/src/app/globals.css) | New | Tailwind and the dark base. |
| [`web-next/src/app/layout.tsx`](../../../web-next/src/app/layout.tsx) | New | The rail: rooms from the daemon, agents, artifacts. |
| [`web-next/src/app/page.tsx`](../../../web-next/src/app/page.tsx) | New | Redirects to the first room. |
| [`web-next/src/app/error.tsx`](../../../web-next/src/app/error.tsx) | New | A daemon refusal in place of the page, with retry. |
| [`web-next/src/app/rooms/[id]/page.tsx`](../../../web-next/src/app/rooms/[id]/page.tsx) | New | The transcript, server-rendered: personas, Markdown, reactions, composer, live refresh. |
| [`web-next/src/app/rooms/[id]/plans/page.tsx`](../../../web-next/src/app/rooms/[id]/plans/page.tsx) | New | Plans, server-rendered. |
| [`web-next/src/app/agents/page.tsx`](../../../web-next/src/app/agents/page.tsx) | New | Agents with start and stop; schedules with pause and resume. |
| [`web-next/src/app/artifacts/page.tsx`](../../../web-next/src/app/artifacts/page.tsx) | New | Lavish sessions with Open review. |
| [`web-next/src/app/api/[...path]/route.ts`](../../../web-next/src/app/api/[...path]/route.ts) | New | The proxy: every /api/* forwarded with the token added server-side. |
| [`web-next/src/app/api/live/route.ts`](../../../web-next/src/app/api/live/route.ts) | New | The daemon's WebSocket relayed as server-sent events. |
| [`web-next/src/components/Markdown.tsx`](../../../web-next/src/components/Markdown.tsx) | New | GFM on the server; a mermaid fence becomes the one client island. |
| [`web-next/src/components/Mermaid.tsx`](../../../web-next/src/components/Mermaid.tsx) | New | The island: mermaid imported on first sight. |
| [`web-next/src/components/Live.tsx`](../../../web-next/src/components/Live.tsx) | New | EventSource on this origin; a relevant frame refreshes the server tree. |
| [`web-next/src/components/Composer.tsx`](../../../web-next/src/components/Composer.tsx) | New | Post as @you through the proxy. |
| [`web-next/src/components/Reactions.tsx`](../../../web-next/src/components/Reactions.tsx) | New | Toggle the operator's reaction through the proxy. |
| [`web-next/src/components/Action.tsx`](../../../web-next/src/components/Action.tsx) | New | One proxied call and a refresh: start, stop, pause, resume, open review. |
| [`package.json`](../../../package.json) | Edited | console:next:* scripts; typecheck covers web-next; test:fast skips the slow suite. |
| [`tsconfig.json`](../../../tsconfig.json) | Edited | web-next excluded from the root program. |
| [`biome.json`](../../../biome.json) | Edited | Next's build output ignored. |
| [`.gitignore`](../../../.gitignore) | Edited | web-next/.next. |
| [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | Edited | Installs web-next's dependencies. |
| [`tests/console-next.test.ts`](../../../tests/console-next.test.ts) | New | Builds and starts Next against a real daemon: Markdown as HTML, no token in the page, no mermaid without a diagram, the proxy, the live stream. |

## Steps

1. Hold the token on the server: resolve the daemon once, fetch through one helper, proxy the API on the app's origin, relay events as SSE.
2. Render bodies as Markdown in server components; isolate mermaid as a client island.
3. Prove it against a booted daemon in the full suite, and keep it out of the package and the fast suite.

## Acceptance

- [x] A room page answers 200 with the message's Markdown already as HTML, the operator token absent from the page, and no mermaid script when no diagram is present.
- [x] The proxy answers the daemon's channels; the live stream opens and relays a message frame.

Evidence:

| Claim | Anchor |
|---|---|
| Next against a real daemon | [`tests/console-next.test.ts`](../../../tests/console-next.test.ts) |

## Out of scope

- Parity with the bundled console (threads, native chats, changes, definition editing, membership, profile editing) and remote-mode ticket auth; listed in the web console guide.

## Depends on

- T-1630

## Unblocks

- Nothing.
