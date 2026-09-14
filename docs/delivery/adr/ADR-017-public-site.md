# ADR-017 — A public homepage and a mocked console demo, hosted outside the daemon

**Status:** Accepted

## Context

The project had no public page: the README was the only way to see what oh-my-agent is, and the console could only be seen by installing the plugin and booting a daemon. The operator asked for a single-page animated homepage and a click-through demo of every console view, hosted on Vercel.

## Decision

Add website/, a Next.js app that is not part of the npm package and not served by the daemon. Its homepage is static. Its /console route mounts the real console from web/src, unchanged, against a browser-local mock of the daemon's console API: fetch, the events WebSocket, and the upload XHR are patched in the browser, state is seeded from fixtures and persisted in localStorage, and the demo operator token is written into the session before the console mounts, so there is no login. Nothing under web/ or src/ changes for the demo.

## Consequences

- The demo drifts from the daemon only when the console API changes; the mock is a route table beside console-api.ts and a smoke script calls every route.
- The package still ships zero runtime dependencies; the site's tree lives in website/node_modules only.
- Two console layout defects surfaced under realistic data and are patched in the demo's CSS; the upstream fix belongs in web/.
- The demo has no login: the mock still refuses requests without the operator token, so the console's auth path runs, but the token is written into the session for every visitor.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Rebuild the console for the demo | Doubles every view and drifts on the first change; mounting the real components is what makes the demo honest. |
| Host a real daemon behind the site | Puts a machine with OMP credentials on the public internet for a demo, which the remote-exposure threat model refuses. |

## Evidence

| Claim | Source |
|---|---|
| The real console mounted against the mock | [`website/src/components/demo/ConsoleApp.tsx`](../../../website/src/components/demo/ConsoleApp.tsx) |
| Every mocked route called once | [`website/scripts/mock-smoke.mjs`](../../../website/scripts/mock-smoke.mjs) |
