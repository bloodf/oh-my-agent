# EP-12 — Beyond loopback: remote exposure with a real trust model

**Status:** Blocked

*Derived from the tasks below.*

## Outcome

An operator can reach the console and the control socket from beyond localhost — through a documented proxy recipe with TLS, an operator token, and parentage that is enforced rather than cooperative.

## Why this is its own epic

Every server the daemon runs binds loopback today, and that is the security model, not an oversight: the console speaks the operator token, room contents cross the wire, and ADR-011's parentage is cooperative metadata. Exposing any of it by 'bind an address' hands the network a rooms leak and an identity system that was never meant to be one. T-1004 built the identity switch; this epic flips it under one declared model instead of letting a bind address decide the trust boundary.

## In scope

- An explicit remote-mode surface: config or flag, refusal when the hardening preconditions are unmet, loopback default unchanged.
- TLS termination via documented reverse-proxy recipes per ADR-012; the daemon never terminates TLS itself.
- Operator auth over the wire in remote mode: every request carries the operator token, and hierarchy enforcement flips from cooperative to authoritative (T-1004's prepared layer).
- An authenticated-connection audit surface: every authenticated remote-mode connection is logged, and a CLI verb reports the active mode and live connections (T-1206).

## Not in scope

- Changing the loopback default; remote exposure is an explicit opt-in, never a side effect of binding an address.
- Multi-tenant authorization — the model is one operator with a token, not per-user accounts.
- Operator-token rotation UX; the manual path is deleting the token file and restarting (covered by the boot suite), and the runbook documents it.

## Acceptance

- [ ] Any non-loopback bind is refused with the reason on stderr, never a partial boot — no flag permits one; remote mode changes auth and enforcement only.
- [ ] In remote mode, a console request or socket connection without the operator token is refused; the loopback default keeps working exactly as today.
- [ ] Parentage enforcement is asserted in remote mode: a worker token cannot kill or inject into a peer it does not own, over a remote-mode connection.
- [ ] Every recipe in the docs (proxy, tailscale, SSH tunnel) carries the same refusal/required-token assertions.
- [ ] Every authenticated remote-mode connection leaves an audit log line, and `omp-agent audit` reports the active trust model and live authenticated connections.

## Decisions

- [ADR-012](../adr/ADR-012-remote-exposure.md) — Beyond loopback, a reverse proxy terminates TLS; the daemon never does

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1201](../tasks/T-1201-exposure-policy.md) | Remote-mode surface and bind refusal | Done |
| [T-1202](../tasks/T-1202-tls-termination.md) | Proxy recipes and behind-proxy correctness | Blocked |
| [T-1203](../tasks/T-1203-remote-console-auth.md) | Operator-token flow in the console client | Done |
| [T-1204](../tasks/T-1204-authoritative-hierarchy.md) | Hierarchy enforcement flips in remote mode | Done |
| [T-1205](../tasks/T-1205-exposure-runbook.md) | Threat model and operator checklist | Blocked |
| [T-1206](../tasks/T-1206-authenticated-connection-audit.md) | Authenticated-connection audit surface | Done |
