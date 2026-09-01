# T-1202 — Proxy recipes and behind-proxy correctness

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

Remote mode is reachable only behind TLS: the docs ship copy-paste proxy recipes, and the suite proves the daemon behaves correctly behind a proxy.

## Read first

- [ADR-012: remote exposure](../../../docs/delivery/adr/ADR-012-remote-exposure.md)
- [Console API](../../../src/daemon/console-api.ts)
- [Identity suite](../../../tests/socket-identity.test.ts)

## Files this task may change

- `docs/remote-exposure.md`
- `tests/remote-exposure.test.ts`
- `src/daemon/console-api.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `docs/remote-exposure.md` (to be created) | New | The three recipes — Caddy, tailscale serve, SSH tunnel — each setting the proxy shared-secret header, carrying a rate-limit stanza and a log-scrub note, and ending in the same three checks. |
| `tests/remote-exposure.test.ts` (to be created) | Edited | Created by T-1201; behind-proxy assertions: forwarded headers honored only with the secret, unproxied remote access refused. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Proxy-aware request handling per the recipe contract: scheme and host from forwarded headers, only when the shared secret matches. |

## Steps

1. Write the three recipes in docs/remote-exposure.md; each sets the proxy shared-secret header, carries a rate-limit stanza, and notes how to scrub token material from the proxy's log format; each ends with the same checks: bind-address config refused unconditionally, token required, hierarchy enforced.
2. Make the console proxy-aware so URLs the client builds are correct behind the documented proxy.
3. Extend the suite: a request carrying forwarded headers without the proxy shared secret is treated as a direct loopback caller — forwarded identity ignored, never trusted.

## Acceptance

- [ ] Each recipe's three checks appear verbatim in the doc and are mirrored by suite assertions.
- [ ] Each recipe is verified once end-to-end against a real proxy, with the date and versions recorded in the doc.
- [ ] `omp-agent console` prints a URL that is correct when the daemon sits behind the documented proxy.

## Out of scope

- The daemon terminating TLS (ADR-012 rejects it) and the login flow UX (T-1203).

## Depends on

- T-1201

## Unblocks

- T-1205
