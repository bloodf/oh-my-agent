# oh-my-agent website

Next.js site for oh-my-agent: the homepage at `/` and the console demo at `/console`.

## Homepage

The homepage lives in `src/app/(home)/` (layout, page, CSS) and `src/components/home/` (sections, hero, WebGL). Custom GLSL for the hero is in `src/shaders/`.

- **Hero.** A React Three Fiber scene: an aubergine night-sky shader behind a constellation of agents (points) exchanging message packets along arcs. The hero is a sticky 230vh scroll: a terminal window running the README quick start closes, and the constellation brightens. The canvas pauses when the hero is off-screen, renders one still frame under `prefers-reduced-motion`, and has a CSS star field underneath for no-WebGL visitors.
- **ThreeUI.** Section backdrops use `@designcodeio/threeui` components that draw their own canvas: `OrbitalSphereBackground` (hierarchy), `BellFieldBackground` (schedules), `LaserCollection` (isolation), `StreamConvergenceBackground` (clients), `WarpFieldBackground` (remote exposure), and `LumenCta` (final call to action). They load through `components/home/threeui/ThreeStage.tsx`: code-split, mounted only near the viewport, skipped under reduced motion, `aria-hidden`. The iframe-based ThreeUI effects that pull CDNs are not used.
- **Facts.** Copy and numbers come from the repository docs. `components/home/data.ts` notes the source of every count (18 CLI verbs from `docs/guide/cli.md`, the theme count from `web/src/lib/themes.ts`, and so on).
- **Theme.** Dark first. The toggle in the nav stores `oma-home-theme` in `localStorage`; with no stored choice the system preference applies. An inline script sets `data-oma-theme` on `<html>` before paint. The hero and final call to action stay night-colored in both themes.
- **Assets.** `public/home/` holds copies of `docs/assets/` files: the mark, favicon, social card, and the two real console captures.

Run it:

```sh
bun run dev          # http://localhost:3300
bun run build
bun run typecheck
```

## Console demo

`/console` is the real web console from `../web/src` (`App` and `ConsoleShell`, imported through the `@` alias and mounted client-only), running against a daemon mocked inside the browser. Nothing under `../web` or `../src` is changed for it.

- **Token.** There is no login: before the console mounts, `src/mock/session.ts` writes the demo token from `src/mock/demoToken.ts` into `sessionStorage["oh-my-agent.operator-token"]`, the key the console reads its operator token from, so every `/api/*` call carries it unchanged; a call without it gets `401 Operator token refused`, which keeps the mock honest about the console's auth path.
- **Mock.** `src/mock/transport.ts` patches three browser seams: `fetch` for `/api/*`, `WebSocket` for `/api/events`, and `XMLHttpRequest` for uploads to `/api/attachments` (with progress events). Everything else goes to the network untouched, Next's HMR socket included. `src/mock/router.ts` dispatches to `routes/{system,rooms,agents,workspace}.ts`, which mirror `src/daemon/console-api.ts` and `src/daemon/web-routes.ts`: same paths, methods, validation, status codes, and `{ error: { code, message } }` envelope. An unknown `/api/*` route answers the daemon's `404 not_found`. `tests/website-mock-parity.test.ts` (root `bun test`) fails when the daemon's route patterns or frame types drift from the mock's.
- **State.** `src/mock/fixtures/` seeds a workspace (project "Quarry"): 7 agents across running, parked, and stopped states (one child, one automated bot with wake rules, cron schedules, and a heartbeat; an agent created in the demo is a bare definition, which Stop, Inject, and Logs answer 404 like the daemon, until it starts), 5 channels and 3 DMs with about 30 Markdown messages (tables, task lists, diffs, a mermaid diagram, threads, reactions), plans with revisions, Git changes with unified diffs, 3 Lavish artifacts, 2 OMP chats with todo phases, presets, and a model catalog. Times are relative to the first visit. `src/mock/store.ts` replaces state immutably on every write and persists it under `localStorage["oh-my-agent-demo:state"]`; on a return visit it checks the stored shape (reseeding on a mismatch) and moves every stored time forward by how long the tab was closed. Streamed chat ticks stay in memory until the turn ends.
- **Live.** Every write publishes the same frame the daemon would (`message`, `reaction`, `agent`, `definition`, `membership`, `channel`, `schedule`, `profile`, `plan`, `chat`; the demo simulates no quota change, so no `budget`). `src/mock/activity.ts` has agents answer the operator (mentions, DM peer, or a room member), post progress about every 40 seconds while a console is open, and stream OMP chat replies that **Stop** aborts.
- **Banner.** `src/components/demo/DemoBanner.tsx` marks the page as a demo and offers **Reset demo data** (clears the `oh-my-agent-demo:` keys and reloads). The Lavish **Open review** links go to a stand-in at `/console/review/[id]`.

Check every mocked route without a browser (statuses, the fields the console reads, unserved routes answering 404, and the frame types published):

```sh
bun scripts/mock-smoke.mjs
```

The transport patches come off when `/console` unmounts, so client navigation back to `/` uses the browser's own `fetch` and `WebSocket`.

Limits: two open tabs each keep their own copy and the last write wins in `localStorage`. File uploads record name, type, and size only; bytes are discarded.

## Commands

```sh
bun install
bun run dev          # http://localhost:3300, webpack dev server
bun run build        # next build --webpack
bun run typecheck
bun scripts/mock-smoke.mjs   # calls every mocked console route once
```

The console demo compiles files under `../web/src`. Their script imports
resolve from this directory's `node_modules` first (every package they use is
a dependency here too, at the version `web/package.json` pins), so the bundle
carries one copy of each. The console stylesheet is the exception: Tailwind
resolves the `@import`s in `../web/src/index.css` from that directory, so
`bun install --cwd ../web --frozen-lockfile` is still needed once. The build
uses webpack because that is where script resolution is pinned, which keeps
one React instance across both trees. React
here is 19.3.0 while `web/` locks 19.2.8: `web/`'s `^19.2.8` range accepts
19.3.0 and only this directory's copy is bundled, so the two trees never run
different React versions side by side.

## Deploy

Vercel project `oh-my-agent` (team `hr-teconologia`), Root Directory
`website`, framework Next.js, production branch `main`. `vercel.json` pins
Bun 1.4.2 for install and build (the platform default cannot read this
lockfile) and installs both this directory and `../web` with
`--frozen-lockfile`.
