# T-1804 — Website claims, demo parity, CI gates, and web-next removal

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-18](../epics/EP-18-review-2026-09.md) | [SP-19](../sprints/SP-19-review-fixes.md) | Done | [asset-map](../asset-map.md) |

## Goal

web-next is gone. CI builds and typechecks the website, runs the demo mock smoke, lints web/, and runs a parity test that fails when the daemon's console routes or frames drift from the mock. The mock answers like the daemon, and the site's claims match the product.

## Read first

- [The review findings C-01, W-01 to W-11, and M-01 to M-12](../../../docs/develop/review-2026-09.md)
- [The decision](../../../docs/delivery/adr/ADR-018-remove-server-rendered-console.md)

## Files this task may change

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.gitignore`
- `README.md`
- `biome.json`
- `docs/web-console.md`
- `package.json`
- `tests/console-next.test.ts`
- `tests/website-mock-parity.test.ts`
- `tsconfig.json`
- `web/.oxlintrc.json`
- `website/README.md`
- `website/bun.lock`
- `website/next.config.ts`
- `website/package.json`
- `website/scripts/mock-smoke.mjs`
- `website/vercel.json`
- `website/src/app/(home)/home.css`
- `website/src/app/(home)/layout.tsx`
- `website/src/app/(home)/responsive.css`
- `website/src/app/console/console.css`
- `website/src/app/console/layout.tsx`
- `website/src/app/layout.tsx`
- `website/src/components/demo/ConsoleApp.tsx`
- `website/src/components/home/data.ts`
- `website/src/components/home/hero/Hero.tsx`
- `website/src/components/home/hero/HeroCanvas.tsx`
- `website/src/components/home/sections/Clients.tsx`
- `website/src/components/home/sections/DemoTeaser.tsx`
- `website/src/components/home/sections/Footer.tsx`
- `website/src/components/home/sections/Isolation.tsx`
- `website/src/components/home/sections/Remote.tsx`
- `website/src/components/home/sections/Transcript.tsx`
- `website/src/components/home/three/Scene.tsx`
- `website/src/components/home/threeui/ThreeStage.tsx`
- `website/src/components/home/ui/chrome.tsx`
- `website/src/mock/activity.ts`
- `website/src/mock/fixtures/agents.ts`
- `website/src/mock/fixtures/index.ts`
- `website/src/mock/index.ts`
- `website/src/mock/messages.ts`
- `website/src/mock/router.ts`
- `website/src/mock/routes/agents.ts`
- `website/src/mock/routes/rooms.ts`
- `website/src/mock/routes/system.ts`
- `website/src/mock/routes/workspace.ts`
- `website/src/mock/store.ts`
- `website/src/mock/transport.ts`
- `website/src/mock/types.ts`
- `web-next/.gitignore`
- `web-next/README.md`
- `web-next/bun.lock`
- `web-next/next.config.ts`
- `web-next/package.json`
- `web-next/postcss.config.mjs`
- `web-next/src/app/agents/page.tsx`
- `web-next/src/app/api/[...path]/route.ts`
- `web-next/src/app/api/live/route.ts`
- `web-next/src/app/artifacts/page.tsx`
- `web-next/src/app/error.tsx`
- `web-next/src/app/favicon.ico`
- `web-next/src/app/globals.css`
- `web-next/src/app/layout.tsx`
- `web-next/src/app/page.tsx`
- `web-next/src/app/rooms/[id]/page.tsx`
- `web-next/src/app/rooms/[id]/plans/page.tsx`
- `web-next/src/components/Action.tsx`
- `web-next/src/components/Composer.tsx`
- `web-next/src/components/Live.tsx`
- `web-next/src/components/Markdown.tsx`
- `web-next/src/components/Mermaid.tsx`
- `web-next/src/components/Reactions.tsx`
- `web-next/src/lib/daemon.ts`
- `web-next/src/lib/types.ts`
- `web-next/tsconfig.json`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | Edited | Website install, typecheck, build, mock smoke, and web lint; no web-next. |
| [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) | Edited | Same gates as CI; no web-next. |
| [`.gitignore`](../../../.gitignore) | Edited | No web-next build output. |
| [`README.md`](../../../README.md) | Edited | Website and demo note. |
| [`biome.json`](../../../biome.json) | Edited | No web-next ignore. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | Server-rendered console section removed. |
| [`package.json`](../../../package.json) | Edited | No console:next scripts or web-next typecheck. |
| `tests/console-next.test.ts` (to be created) | Edited | Deleted with web-next. |
| [`tests/website-mock-parity.test.ts`](../../../tests/website-mock-parity.test.ts) | Edited | Fails when the daemon gains a console route or frame the mock lacks. |
| [`tsconfig.json`](../../../tsconfig.json) | Edited | No web-next exclude. |
| [`web/.oxlintrc.json`](../../../web/.oxlintrc.json) | Edited | exhaustive-deps as a warning. |
| [`website/README.md`](../../../website/README.md) | Edited | Six themes; demo parity notes. |
| [`website/bun.lock`](../../../website/bun.lock) | Edited | Locked with the console's direct dependencies. |
| [`website/next.config.ts`](../../../website/next.config.ts) | Edited | No dead Turbopack block. |
| [`website/package.json`](../../../website/package.json) | Edited | Declares the console dependencies the build compiles. |
| [`website/scripts/mock-smoke.mjs`](../../../website/scripts/mock-smoke.mjs) | Edited | Fails on unknown routes, unexpected shapes, and a changed frame set; covers every paging mode. |
| [`website/vercel.json`](../../../website/vercel.json) | Edited | Frozen-lockfile installs. |
| [`website/src/app/(home)/home.css`](../../../website/src/app/%28home%29/home.css) | Edited | Contrast and focus fixes. |
| [`website/src/app/(home)/layout.tsx`](../../../website/src/app/%28home%29/layout.tsx) | Edited | Canonical link. |
| [`website/src/app/(home)/responsive.css`](../../../website/src/app/%28home%29/responsive.css) | Edited | Footer heading styles. |
| [`website/src/app/console/console.css`](../../../website/src/app/console/console.css) | Edited | Stale Schedules scroll workaround removed. |
| [`website/src/app/console/layout.tsx`](../../../website/src/app/console/layout.tsx) | Edited | Demo layout metadata. |
| [`website/src/app/layout.tsx`](../../../website/src/app/layout.tsx) | Edited | metadataBase from the deployment URL before localhost. |
| [`website/src/components/demo/ConsoleApp.tsx`](../../../website/src/components/demo/ConsoleApp.tsx) | Edited | Uninstalls the mock transport on unmount; no __omaAsset. |
| [`website/src/components/home/data.ts`](../../../website/src/components/home/data.ts) | Edited | Theme count from the source; models in the verb list. |
| [`website/src/components/home/hero/Hero.tsx`](../../../website/src/components/home/hero/Hero.tsx) | Edited | Demo wording. |
| [`website/src/components/home/hero/HeroCanvas.tsx`](../../../website/src/components/home/hero/HeroCanvas.tsx) | Edited | Releases probe contexts; context-lost fallback. |
| [`website/src/components/home/sections/Clients.tsx`](../../../website/src/components/home/sections/Clients.tsx) | Edited | Six themes. |
| [`website/src/components/home/sections/DemoTeaser.tsx`](../../../website/src/components/home/sections/DemoTeaser.tsx) | Edited | Accessible link names. |
| [`website/src/components/home/sections/Footer.tsx`](../../../website/src/components/home/sections/Footer.tsx) | Edited | Heading order. |
| [`website/src/components/home/sections/Isolation.tsx`](../../../website/src/components/home/sections/Isolation.tsx) | Edited | Accessibility audit fix. |
| [`website/src/components/home/sections/Remote.tsx`](../../../website/src/components/home/sections/Remote.tsx) | Edited | Tailscale recipe verified; origin required only in remote mode. |
| [`website/src/components/home/sections/Transcript.tsx`](../../../website/src/components/home/sections/Transcript.tsx) | Edited | Accessibility audit fix. |
| [`website/src/components/home/three/Scene.tsx`](../../../website/src/components/home/three/Scene.tsx) | Edited | Context-lost handling. |
| [`website/src/components/home/threeui/ThreeStage.tsx`](../../../website/src/components/home/threeui/ThreeStage.tsx) | Edited | Releases WebGL contexts on unmount. |
| [`website/src/components/home/ui/chrome.tsx`](../../../website/src/components/home/ui/chrome.tsx) | Edited | Demo wording and link names. |
| [`website/src/mock/activity.ts`](../../../website/src/mock/activity.ts) | Edited | Tracked greeting timer; throttled persistence while streaming. |
| [`website/src/mock/fixtures/agents.ts`](../../../website/src/mock/fixtures/agents.ts) | Edited | No account fixtures. |
| [`website/src/mock/fixtures/index.ts`](../../../website/src/mock/fixtures/index.ts) | Edited | No account fixtures. |
| [`website/src/mock/index.ts`](../../../website/src/mock/index.ts) | Edited | Transport uninstall export. |
| [`website/src/mock/messages.ts`](../../../website/src/mock/messages.ts) | Edited | Daemon paging. |
| [`website/src/mock/router.ts`](../../../website/src/mock/router.ts) | Edited | 404 for unknown routes; exported route table. |
| [`website/src/mock/routes/agents.ts`](../../../website/src/mock/routes/agents.ts) | Edited | Stopped-agent and definition-only statuses; keptChildren. |
| [`website/src/mock/routes/rooms.ts`](../../../website/src/mock/routes/rooms.ts) | Edited | Plan errors, message paging, and channel frames as the daemon sends them. |
| [`website/src/mock/routes/system.ts`](../../../website/src/mock/routes/system.ts) | Edited | Image avatars; no bump route. |
| [`website/src/mock/routes/workspace.ts`](../../../website/src/mock/routes/workspace.ts) | Edited | truncated on inspection; upload size cap. |
| [`website/src/mock/store.ts`](../../../website/src/mock/store.ts) | Edited | Validated stored state and re-seeded timestamps. |
| [`website/src/mock/transport.ts`](../../../website/src/mock/transport.ts) | Edited | Uninstallable patches; upload size cap. |
| [`website/src/mock/types.ts`](../../../website/src/mock/types.ts) | Edited | Frame type follows the daemon. |
| `web-next/.gitignore` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/README.md` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/bun.lock` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/next.config.ts` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/package.json` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/postcss.config.mjs` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/agents/page.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/api/[...path]/route.ts` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/api/live/route.ts` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/artifacts/page.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/error.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/favicon.ico` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/globals.css` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/layout.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/page.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/rooms/[id]/page.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/app/rooms/[id]/plans/page.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/components/Action.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/components/Composer.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/components/Live.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/components/Markdown.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/components/Mermaid.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/components/Reactions.tsx` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/lib/daemon.ts` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/src/lib/types.ts` (to be created) | Edited | Deleted with web-next (ADR-018). |
| `web-next/tsconfig.json` (to be created) | Edited | Deleted with web-next (ADR-018). |

## Steps

1. Delete web-next and every reference to it.
2. Gate the website and mock in CI and add the parity test.
3. Match the mock to the daemon and correct the site's claims.

## Acceptance

- [x] CI runs the website build, the mock smoke, and the parity test on every push and pull request.
- [x] The mock answers unknown routes with 404 and pages messages like the daemon.
- [x] The homepage states six themes and a verified tailscale recipe.

Evidence:

| Claim | Anchor |
|---|---|
| Mock parity test | [`tests/website-mock-parity.test.ts`](../../../tests/website-mock-parity.test.ts) |
| Mock smoke | [`website/scripts/mock-smoke.mjs`](../../../website/scripts/mock-smoke.mjs) |

## Out of scope

- A website-only install: Tailwind resolves web/src/index.css imports from web/, so Vercel installs both directories.

## Depends on

- T-1802

## Unblocks

- Nothing.
