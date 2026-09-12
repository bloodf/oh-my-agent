# ADR-016 — A server-rendered console beside the bundled one, not in place of it

**Status:** Accepted

## Context

The operator asked for the console to run on a Next.js server with server-side rendering to cut what the browser downloads. The bundled console is what the daemon serves from an allowlist under src/console/ with token and ticket auth, and it is what the npm package ships; its size came from mermaid, not from client rendering, and lazy chunks (T-1630) took app.js from six megabytes to under one.

## Decision

Add web-next/, a Next.js app that renders pages on the server and holds the operator token there, proxying the daemon's console API on its own origin and relaying daemon frames as server-sent events. It is a development and self-hosting surface beside the bundled console, built and tested in the full suite against a real daemon, and not part of the npm package. The daemon keeps serving the bundled console; nothing in the plugin's install path depends on Node or Next.

## Consequences

- Two consoles share one API; a feature lands in the daemon once and each console picks it up.
- The Next console carries a parity list in the web console guide until it matches the bundled one.
- The package still ships zero runtime dependencies; Next's tree lives in web-next/node_modules only.
- Remote-mode ticket authentication is the bundled console's; the Next console runs beside the daemon on loopback.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Replace the bundled console with Next inside the plugin | Puts a Node server and a hundred-megabyte dependency tree into an OMP plugin that ships none, and re-implements token, ticket, and remote-mode auth in a second process for no size gain: mermaid renders in the browser either way. |
| Only lazy chunks | Delivers the size cut but not what was asked: a server that renders pages. |

## Evidence

| Claim | Source |
|---|---|
| The Next console against a real daemon | [`tests/console-next.test.ts`](../../../tests/console-next.test.ts) |
| The daemon's own console serving | [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) |
