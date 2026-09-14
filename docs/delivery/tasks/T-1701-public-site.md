# T-1701 — Public homepage and mocked console demo on Vercel

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-17](../epics/EP-17-public-site.md) | [SP-18](../sprints/SP-18-public-site.md) | Done | [asset-map](../asset-map.md) |

## Goal

A Next.js site under website/ hosts a single-page animated homepage at / and, at /console, the real console from web/src mounted against a browser-local mock of the daemon's console API, seeded with agents, accounts, rooms, threads, plans, changes, artifacts, schedules, and chats, with every mutation persisted in localStorage. It deploys from the repository to Vercel and stays out of the npm package.

## Read first

- [The decision](../../../docs/delivery/adr/ADR-017-public-site.md)
- [The console API the mock answers](../../../src/daemon/console-api.ts)
- [The console the demo mounts](../../../web/src/console/ConsoleShell.tsx)
- [The brand](../../../docs/assets/README.md)

## Files this task may change

- `website/package.json`
- `website/bun.lock`
- `website/next.config.ts`
- `website/tsconfig.json`
- `website/postcss.config.mjs`
- `website/.gitignore`
- `website/README.md`
- `website/AGENTS.md`
- `website/CLAUDE.md`
- `website/scripts/mock-smoke.mjs`
- `website/public/home/collaboration.png`
- `website/public/home/console.png`
- `website/public/home/favicon.svg`
- `website/public/home/mark.svg`
- `website/public/home/social.png`
- `website/src/app/layout.tsx`
- `website/src/app/globals.css`
- `website/src/app/(home)/layout.tsx`
- `website/src/app/(home)/page.tsx`
- `website/src/app/(home)/home.css`
- `website/src/app/(home)/hero.css`
- `website/src/app/(home)/story.css`
- `website/src/app/(home)/systems.css`
- `website/src/app/(home)/closing.css`
- `website/src/app/(home)/responsive.css`
- `website/src/app/console/layout.tsx`
- `website/src/app/console/page.tsx`
- `website/src/app/console/console.css`
- `website/src/app/console/review/[id]/page.tsx`
- `website/src/components/demo/ConsoleApp.tsx`
- `website/src/components/demo/ConsoleClient.tsx`
- `website/src/components/demo/DemoBanner.tsx`
- `website/src/components/home/data.ts`
- `website/src/components/home/hero/Hero.tsx`
- `website/src/components/home/hero/HeroCanvas.tsx`
- `website/src/components/home/hero/TerminalWindow.tsx`
- `website/src/components/home/three/Scene.tsx`
- `website/src/components/home/three/constellation.ts`
- `website/src/components/home/threeui/ThreeStage.tsx`
- `website/src/components/home/ui/chrome.tsx`
- `website/src/components/home/ui/primitives.tsx`
- `website/src/components/home/sections/Daemon.tsx`
- `website/src/components/home/sections/Rooms.tsx`
- `website/src/components/home/sections/Transcript.tsx`
- `website/src/components/home/sections/Hierarchy.tsx`
- `website/src/components/home/sections/Artifacts.tsx`
- `website/src/components/home/sections/Schedules.tsx`
- `website/src/components/home/sections/Quota.tsx`
- `website/src/components/home/sections/Isolation.tsx`
- `website/src/components/home/sections/Clients.tsx`
- `website/src/components/home/sections/Remote.tsx`
- `website/src/components/home/sections/QuickStart.tsx`
- `website/src/components/home/sections/Compare.tsx`
- `website/src/components/home/sections/DemoTeaser.tsx`
- `website/src/components/home/sections/FinalCta.tsx`
- `website/src/components/home/sections/Footer.tsx`
- `website/src/shaders/night.ts`
- `website/src/shaders/agents.ts`
- `website/src/mock/demoToken.ts`
- `website/src/mock/index.ts`
- `website/src/mock/session.ts`
- `website/src/mock/types.ts`
- `website/src/mock/bus.ts`
- `website/src/mock/http.ts`
- `website/src/mock/cron.ts`
- `website/src/mock/store.ts`
- `website/src/mock/messages.ts`
- `website/src/mock/activity.ts`
- `website/src/mock/router.ts`
- `website/src/mock/transport.ts`
- `website/src/mock/routes/system.ts`
- `website/src/mock/routes/rooms.ts`
- `website/src/mock/routes/agents.ts`
- `website/src/mock/routes/workspace.ts`
- `website/src/mock/fixtures/index.ts`
- `website/src/mock/fixtures/workspace.ts`
- `website/src/mock/fixtures/agents.ts`
- `website/src/mock/fixtures/rooms.ts`
- `website/src/mock/fixtures/chats.ts`
- `tsconfig.json`
- `biome.json`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`website/package.json`](../../../website/package.json) | New | next, react, three, react-three-fiber, drei, motion, lenis, @designcodeio/threeui, and the console's own UI dependencies; dev on 3300, build, start, typecheck. |
| [`website/bun.lock`](../../../website/bun.lock) | New | Locked. |
| [`website/next.config.ts`](../../../website/next.config.ts) | New | externalDir; @ aliased to web/src and @site to the site; ThreeUI's three128 aliased to the app's three. |
| [`website/tsconfig.json`](../../../website/tsconfig.json) | New | React types pinned to website/node_modules so web/src compiles against one copy. |
| [`website/postcss.config.mjs`](../../../website/postcss.config.mjs) | New | Tailwind v4. |
| [`website/.gitignore`](../../../website/.gitignore) | New | Build output, .vercel, env files. |
| [`website/README.md`](../../../website/README.md) | New | What the two surfaces are, how the demo reuses the console, commands, deploy. |
| [`website/AGENTS.md`](../../../website/AGENTS.md) | New | Written by next dev; committed so the tree stays clean. |
| [`website/CLAUDE.md`](../../../website/CLAUDE.md) | New | Written by next dev; committed so the tree stays clean. |
| [`website/scripts/mock-smoke.mjs`](../../../website/scripts/mock-smoke.mjs) | New | Calls every mocked route once with and without the token; reports throws and unexpected statuses. |
| [`website/public/home/collaboration.png`](../../../website/public/home/collaboration.png) | New | Copied from docs/assets. |
| [`website/public/home/console.png`](../../../website/public/home/console.png) | New | Copied from docs/assets. |
| [`website/public/home/favicon.svg`](../../../website/public/home/favicon.svg) | New | Copied from docs/assets. |
| [`website/public/home/mark.svg`](../../../website/public/home/mark.svg) | New | Copied from docs/assets. |
| [`website/public/home/social.png`](../../../website/public/home/social.png) | New | Copied from docs/assets. |
| [`website/src/app/layout.tsx`](../../../website/src/app/layout.tsx) | New | Metadata, Open Graph card, icon. |
| [`website/src/app/globals.css`](../../../website/src/app/globals.css) | New | Tailwind with sources under the site and web/src. |
| [`website/src/app/(home)/layout.tsx`](../../../website/src/app/%28home%29/layout.tsx) | New | Theme pre-paint script and the homepage frame. |
| [`website/src/app/(home)/page.tsx`](../../../website/src/app/%28home%29/page.tsx) | New | The sections in narrative order. |
| [`website/src/app/(home)/home.css`](../../../website/src/app/%28home%29/home.css) | New | Homepage styles. |
| [`website/src/app/(home)/hero.css`](../../../website/src/app/%28home%29/hero.css) | New | Homepage styles. |
| [`website/src/app/(home)/story.css`](../../../website/src/app/%28home%29/story.css) | New | Homepage styles. |
| [`website/src/app/(home)/systems.css`](../../../website/src/app/%28home%29/systems.css) | New | Homepage styles. |
| [`website/src/app/(home)/closing.css`](../../../website/src/app/%28home%29/closing.css) | New | Homepage styles. |
| [`website/src/app/(home)/responsive.css`](../../../website/src/app/%28home%29/responsive.css) | New | Homepage styles. |
| [`website/src/app/console/layout.tsx`](../../../website/src/app/console/layout.tsx) | New | Loads the console's index.css and wraps pages in the demo guard. |
| [`website/src/app/console/page.tsx`](../../../website/src/app/console/page.tsx) | New | Mounts the console client-only. |
| [`website/src/app/console/console.css`](../../../website/src/app/console/console.css) | New | Banner offset and two layout fixes for the agent sheet's Schedules tab. |
| [`website/src/app/console/review/[id]/page.tsx`](../../../website/src/app/console/review/[id]/page.tsx) | New | Stand-in for a Lavish review page the demo cannot open. |
| [`website/src/components/demo/ConsoleApp.tsx`](../../../website/src/components/demo/ConsoleApp.tsx) | New | Installs the mock backend, __omaAsset, and the theme, then renders the console's App, in main.tsx's order. |
| [`website/src/components/demo/ConsoleClient.tsx`](../../../website/src/components/demo/ConsoleClient.tsx) | New | next/dynamic with ssr off. |
| [`website/src/components/demo/DemoBanner.tsx`](../../../website/src/components/demo/DemoBanner.tsx) | New | Demo notice with reset. |
| [`website/src/components/home/data.ts`](../../../website/src/components/home/data.ts) | New | Every count on the page with a comment naming its source in the repo. |
| [`website/src/components/home/hero/Hero.tsx`](../../../website/src/components/home/hero/Hero.tsx) | New | The WebGL hero. |
| [`website/src/components/home/hero/HeroCanvas.tsx`](../../../website/src/components/home/hero/HeroCanvas.tsx) | New | The WebGL hero. |
| [`website/src/components/home/hero/TerminalWindow.tsx`](../../../website/src/components/home/hero/TerminalWindow.tsx) | New | The WebGL hero. |
| [`website/src/components/home/three/Scene.tsx`](../../../website/src/components/home/three/Scene.tsx) | New | The WebGL hero. |
| [`website/src/components/home/three/constellation.ts`](../../../website/src/components/home/three/constellation.ts) | New | The WebGL hero. |
| [`website/src/components/home/threeui/ThreeStage.tsx`](../../../website/src/components/home/threeui/ThreeStage.tsx) | New | Lazy, off-screen-paused, reduced-motion-aware wrapper for ThreeUI canvases with a CSS fallback. |
| [`website/src/components/home/ui/chrome.tsx`](../../../website/src/components/home/ui/chrome.tsx) | New | Shared homepage primitives. |
| [`website/src/components/home/ui/primitives.tsx`](../../../website/src/components/home/ui/primitives.tsx) | New | Shared homepage primitives. |
| [`website/src/components/home/sections/Daemon.tsx`](../../../website/src/components/home/sections/Daemon.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Rooms.tsx`](../../../website/src/components/home/sections/Rooms.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Transcript.tsx`](../../../website/src/components/home/sections/Transcript.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Hierarchy.tsx`](../../../website/src/components/home/sections/Hierarchy.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Artifacts.tsx`](../../../website/src/components/home/sections/Artifacts.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Schedules.tsx`](../../../website/src/components/home/sections/Schedules.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Quota.tsx`](../../../website/src/components/home/sections/Quota.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Isolation.tsx`](../../../website/src/components/home/sections/Isolation.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Clients.tsx`](../../../website/src/components/home/sections/Clients.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Remote.tsx`](../../../website/src/components/home/sections/Remote.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/QuickStart.tsx`](../../../website/src/components/home/sections/QuickStart.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Compare.tsx`](../../../website/src/components/home/sections/Compare.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/DemoTeaser.tsx`](../../../website/src/components/home/sections/DemoTeaser.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/FinalCta.tsx`](../../../website/src/components/home/sections/FinalCta.tsx) | New | One homepage section. |
| [`website/src/components/home/sections/Footer.tsx`](../../../website/src/components/home/sections/Footer.tsx) | New | One homepage section. |
| [`website/src/shaders/night.ts`](../../../website/src/shaders/night.ts) | New | The WebGL hero. |
| [`website/src/shaders/agents.ts`](../../../website/src/shaders/agents.ts) | New | The WebGL hero. |
| [`website/src/mock/demoToken.ts`](../../../website/src/mock/demoToken.ts) | New | The operator token the mock accepts; written into the session before the console mounts. |
| [`website/src/mock/index.ts`](../../../website/src/mock/index.ts) | New | Part of the mock backend. |
| [`website/src/mock/session.ts`](../../../website/src/mock/session.ts) | New | Part of the mock backend. |
| [`website/src/mock/types.ts`](../../../website/src/mock/types.ts) | New | Part of the mock backend. |
| [`website/src/mock/bus.ts`](../../../website/src/mock/bus.ts) | New | Part of the mock backend. |
| [`website/src/mock/http.ts`](../../../website/src/mock/http.ts) | New | Part of the mock backend. |
| [`website/src/mock/cron.ts`](../../../website/src/mock/cron.ts) | New | Part of the mock backend. |
| [`website/src/mock/store.ts`](../../../website/src/mock/store.ts) | New | Immutable updates persisted under the demo prefix; reset clears it. |
| [`website/src/mock/messages.ts`](../../../website/src/mock/messages.ts) | New | Part of the mock backend. |
| [`website/src/mock/activity.ts`](../../../website/src/mock/activity.ts) | New | Agent replies, the live trickle, and chat streaming. |
| [`website/src/mock/router.ts`](../../../website/src/mock/router.ts) | New | Token check, dispatch, 405, and a logged generic answer for unknown routes. |
| [`website/src/mock/transport.ts`](../../../website/src/mock/transport.ts) | New | Patches fetch for /api/*, WebSocket for /api/events, and XHR for attachments only. |
| [`website/src/mock/routes/system.ts`](../../../website/src/mock/routes/system.ts) | New | Mocked routes for this area of the console API. |
| [`website/src/mock/routes/rooms.ts`](../../../website/src/mock/routes/rooms.ts) | New | Mocked routes for this area of the console API. |
| [`website/src/mock/routes/agents.ts`](../../../website/src/mock/routes/agents.ts) | New | Mocked routes for this area of the console API. |
| [`website/src/mock/routes/workspace.ts`](../../../website/src/mock/routes/workspace.ts) | New | Mocked routes for this area of the console API. |
| [`website/src/mock/fixtures/index.ts`](../../../website/src/mock/fixtures/index.ts) | New | Seed data. |
| [`website/src/mock/fixtures/workspace.ts`](../../../website/src/mock/fixtures/workspace.ts) | New | Seed data. |
| [`website/src/mock/fixtures/agents.ts`](../../../website/src/mock/fixtures/agents.ts) | New | Seed data. |
| [`website/src/mock/fixtures/rooms.ts`](../../../website/src/mock/fixtures/rooms.ts) | New | Seed data. |
| [`website/src/mock/fixtures/chats.ts`](../../../website/src/mock/fixtures/chats.ts) | New | Seed data. |
| [`tsconfig.json`](../../../tsconfig.json) | Edited | website excluded from the root program. |
| [`biome.json`](../../../biome.json) | Edited | website excluded, like web. |

## Steps

1. Scaffold the site with @ aliased to web/src and one React, and prove an empty build.
2. Mount the real console client-only with the demo token already in the session; patch fetch, the events WebSocket, and the upload XHR; seed fixtures and persist state; answer every route in console-api.ts.
3. Build the homepage from the README and ARCHITECTURE with lazy WebGL scenes and ThreeUI components; source every number.
4. Drive both surfaces in a real browser at desktop and phone widths, then link the Vercel project with website as its root.

## Acceptance

- [x] Opening /console lands on the console shell with the seeded rooms; a request without the demo token is refused with 401.
- [x] Every console view, the agent sheet's four tabs, plans with revision conflicts, changes with diffs, artifacts, profile, appearance, the command palette, every creation dialog, uploads, and OMP chats work in the browser, and a reload keeps what was changed.
- [x] The mock smoke script calls every route in the mock's table and reports zero throws.
- [x] The homepage has no horizontal overflow at 400px, mounts its canvases lazily, and degrades under reduced motion.
- [x] The site builds and typechecks on its own; the root typecheck and lint exclude it; nothing under web/ or src/ changes.

Evidence:

| Claim | Anchor |
|---|---|
| Every view and dialog driven in Chrome at 1440 and 390 wide with zero uncaught errors, on 2026-09-14 | [`website/src/components/demo/ConsoleApp.tsx`](../../../website/src/components/demo/ConsoleApp.tsx) |
| 46 of 46 mocked routes called, no throws, no unexpected statuses | [`website/scripts/mock-smoke.mjs`](../../../website/scripts/mock-smoke.mjs) |
| Homepage scrolled end to end at 1440 dark and light and 400 with reduced motion: canvases mounted, no overflow, zero errors from site code | [`website/src/components/home/threeui/ThreeStage.tsx`](../../../website/src/components/home/threeui/ThreeStage.tsx) |
| next build lists /, /console, /console/review/[id]; tsc clean in website; root lint and typecheck clean with website excluded | [`website/package.json`](../../../website/package.json) |

## Out of scope

- Fixing the two agent-sheet layout defects in web/ itself; the demo patches them in its own CSS and notes them for upstream. Lighthouse and frame-rate measurement on real GPUs.

## Depends on

- Nothing.

## Unblocks

- Nothing.
