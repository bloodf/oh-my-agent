# ADR-012 — Beyond loopback, a reverse proxy terminates TLS; the daemon never does

**Status:** Accepted

## Context

Every server the daemon runs binds loopback today, and that is the stated trust model: the console is a rooms leak if it binds a routable address (its comment says so), and T-1004's connection identity was built as a switch that has never been flipped. The moment an operator wants the console on a LAN, a tailnet, or a remote box, 'bind an address and hope' is the intuitive answer and the expensive one: the console speaks the operator token over plaintext, room contents cross the network, and the cooperative parentage metadata (ADR-011) becomes authoritative trust nobody intended. The epic that owns remote exposure needs the model decided before any bind-address flag ships.

## Decision

The daemon never terminates TLS and never binds a routable address — in any mode. Exposure beyond loopback goes through a documented reverse proxy (Caddy, nginx, tailscale serve, or an SSH tunnel) that terminates TLS and forwards to the loopback console/control endpoints. The daemon gains an explicit opt-in flag acknowledging remote mode, and the flag changes authentication and enforcement only: (a) the operator token is required on every console request and control-socket connection, and (b) parentage flips from cooperative metadata to enforced identity per T-1004's prepared bearer layer. Any bind-address configuration is refused unconditionally, flag or no flag — there is no mode in which the daemon listens on a routable address. The proxy reaches the daemon over loopback like any other local process, so remote mode also requires a per-install proxy shared-secret header on console requests — generated at boot, stored next to the operator token, set by every recipe — and forwarded identity (X-Forwarded-*) is honored only when the secret matches: a direct loopback caller forging those headers gains nothing, and the suite says so. No remote mode, no enforcement change — loopback stays the documented default and keeps today's flows working.

## Consequences

- The console and control socket keep their loopback-only binds in every mode; the only new code is the unconditional bind refusal, the flag, and the proxy-secret check.
- Parentage enforcement becomes real only in remote mode, so loopback single-operator flows keep working unchanged (T-1004's tests stand).
- Documentation owns the proxy recipes; the daemon ships no TLS code, no cert lifecycle, no reload semantics.
- The operator token never rides URLs in remote mode: the WebSocket upgrade and static loads authenticate with a one-time ticket or a __Host- cookie, so proxy access logs and browser history never see it.
- The credential gateway stays loopback-always and is never proxied; remote mode changes nothing about it.
- Every proxy recipe carries a rate-limit stanza; the daemon does not grow backoff logic of its own.
- Token comparison is constant-time on every listener — the control socket's identity Map lookup in socket.ts included.
- Every exposure recipe carries the same assertions in the suite: bind-address config refused unconditionally, token required, forwarded identity ignored without the proxy secret, hierarchy enforced when remote.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Daemon-side TLS | Duplicates cert lifecycle, reload, and ALPN semantics that mature proxies already solve, and a unix-socket-first daemon has no TLS code path today to extend. |
| Tailscale-only as the model | A deployment recipe, not a trust model — kept as a documented recipe, alongside the generic proxy recipe. |
| SSH tunnel as the only story | Works for one operator with shell access; it cannot serve the console to a browser on a phone, which is the actual ask. |

## Evidence

| Claim | Source |
|---|---|
| Console's own loopback-only stance | [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) |
| The identity switch this flips | [`docs/delivery/tasks/T-1004-control-socket-identity.md`](../../../docs/delivery/tasks/T-1004-control-socket-identity.md) |
