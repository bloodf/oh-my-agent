# T-1202 — Proxy recipes and behind-proxy correctness

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-12](../epics/EP-12-remote-exposure.md) | [SP-13](../sprints/SP-13-beyond-loopback.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

Remote mode is reachable only behind TLS: the docs ship copy-paste proxy recipes, and the suite proves the daemon behaves correctly behind a proxy.

## Read first

- [ADR-012: remote exposure](../../../docs/delivery/adr/ADR-012-remote-exposure.md)
- [Console API](../../../src/daemon/console-api.ts)
- [Daemon console URL owner](../../../src/daemon/main.ts)
- [Identity suite](../../../tests/socket-identity.test.ts)

## Files this task may change

- `docs/remote-exposure.md`
- `tests/remote-exposure.test.ts`
- `src/daemon/console-api.ts`
- `src/daemon/main.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`docs/remote-exposure.md`](../../../docs/remote-exposure.md) | New | Three usable HTTPS recipes -- Caddy, tailscale serve, and SSH tunnel paired with loopback Caddy -- set the proxy shared-secret header, rate limiting, log scrubbing, and the required external origin; the SSH+Caddy recipe uses a matching non-loopback origin hostname (oma-console.test) locally mapped via /etc/hosts into the tunnel, deliberately avoiding the daemon's loopback carve-out; the SSH-only section rejects an unsafe configuration that cannot satisfy the HTTPS-origin precondition on its own. |
| [`tests/remote-exposure.test.ts`](../../../tests/remote-exposure.test.ts) | Edited | Created by T-1201; behind-proxy assertions: forwarded headers honored only with the secret, unproxied remote access refused. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Proxy-aware request handling per the recipe contract: scheme and host from forwarded headers, only when the shared secret matches. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Requires an explicit external HTTPS origin whenever remote mode serves the console, validates it, and persists/announces it without the long-lived operator token; a headless remote daemon (OMA_CONSOLE=0) needs no origin, and loopback URLs retain their token. |

## Steps

1. Write the Caddy, tailscale serve, and SSH tunnel with loopback Caddy HTTPS recipes in docs/remote-exposure.md; each sets the external console origin and proxy shared-secret header, carries a rate-limit stanza, notes how to scrub token material from proxy logs, and ends with the same checks: bind-address config refused unconditionally, token required, hierarchy enforced. The SSH+Caddy recipe uses a matching non-loopback origin hostname locally mapped to the tunnel, not localhost, so it exercises the same origin/token hardening a real DNS name gets. Document why SSH alone, without a paired Caddy boundary, cannot satisfy the HTTPS-origin precondition.
2. Make the console proxy-aware so URLs the client builds are correct behind the documented proxy.
3. Extend the suite: a request carrying forwarded headers without the proxy shared secret is treated as a direct loopback caller — forwarded identity ignored, never trusted.
4. Extend the boot preflight: remote mode with the console enabled refuses a missing or empty external origin before the pidfile or any listener; remote mode with OMA_CONSOLE=0 needs none.

## Acceptance

- [ ] Each usable HTTPS recipe's three checks appear verbatim in the doc and are mirrored by suite assertions; the SSH-only configuration (SSH with no paired TLS/auth proxy) is explicitly rejected, distinct from the accepted SSH-tunnel-with-loopback-Caddy recipe.
- [ ] Each usable HTTPS recipe is verified once end-to-end against a real proxy, with the date and versions recorded in the doc.
- [ ] `omp-agent console` prints a URL that is correct when the daemon sits behind the documented proxy.
- [ ] Remote mode with the console enabled and no external origin configured fails before the pidfile or any listener opens; a headless remote daemon (OMA_CONSOLE=0) boots without one, and loopback mode is unaffected.

## Out of scope

- The daemon terminating TLS (ADR-012 rejects it) and the login flow UX (T-1203). Remaining blocker: acceptance is per-recipe, so all three usable HTTPS recipes — Caddy, tailscale serve, and SSH tunnel paired with loopback Caddy — each need their own dated end-to-end run against a real proxy. Verifying one converts one row and does not unblock this task or T-1205; the tailnet and second-host recipes need infrastructure a single workstation does not have.

## Depends on

- T-1201

## Unblocks

- T-1205
