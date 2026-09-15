# ADR-018 — Remove the server-rendered console

**Status:** Accepted

## Context

ADR-016 added web-next/ beside the bundled console. The September 2026 review found its proxy attached the operator token to every /api request with no authentication, origin, or host check while Next listened on every interface, so anyone on the network or any web page could drive the daemon. It also cached a stale daemon port, mirrored wire types by hand, and lacked threads, chats, changes, definition editing, and remote auth.

## Decision

Delete web-next/ and its suite, scripts, CI steps, and docs. The daemon's bundled console is the only console, and the lazy chunks from T-1630 keep its first load small.

## Consequences

- One console to secure, test, and keep in step with the daemon's API.
- CI no longer installs, typechecks, builds, or boots a second Next app.
- Server-side rendering is gone; nothing in the plugin depended on it.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Harden web-next | Binding to loopback and adding auth, origin checks, and port refresh would keep a second hand-mirrored console that still lagged the bundled one on half its features. |

## Evidence

| Claim | Source |
|---|---|
| The review that found the proxy exposure | [`docs/develop/review-2026-09.md`](../../../docs/develop/review-2026-09.md) |
| CI without the Next console | [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) |
