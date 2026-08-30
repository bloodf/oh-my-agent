# EP-10 — Production wiring: serving, usage, and deferred hardening

**Status:** Planned

*Derived from the tasks below.*

## Outcome

The console is reachable for real — the daemon serves the API and the client behind an operator token — and budgets are fed by actual usage. The deferred hardening (connection identity, credential-env scoping, in-process workers) is specified with its trigger so the deferral is a decision, not an oversight.

## Why this is its own epic

Three subsystems were built and tested without a production seam: the console API is never mounted by the daemon, the meter is never fed, and the worker pid is never recorded. Each is small, each is load-bearing for actually operating the system, and each was out of scope for the epic that built its subsystem.

## In scope

- Mounting the console API at boot with the operator-token lifecycle and static client serving.
- Account-to-credential binding and gateway-usage polling into the meter.
- Worker pid from the lifecycle onto the wire and into the registry.
- Specified-but-parked hardening: connection identity, credential-env scoping, in-process workers.

## Not in scope

- Any new UI surface; this epic is backend seams for the surfaces that exist.
- Non-loopback exposure of the console (that is what triggers T-1004).

## Acceptance

- [ ] A browser reaches the console served by the daemon itself, with the token flow documented in docs/web-console.md.
- [ ] A metered account's meter moves with real usage, and the 80%/park/bump path fires on it.
- [ ] Status and the registry report a real pid for a running worker.

## Decisions

- [ADR-011](../adr/ADR-011-agent-hierarchy.md) — Persistent child agents are spawn-time state; kill cascades

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1001](../tasks/T-1001-console-mounted-at-boot.md) | Serve the console from the daemon | Done |
| [T-1002](../tasks/T-1002-usage-feeds-the-meter.md) | Usage feeds the meter | Done |
| [T-1003](../tasks/T-1003-worker-pid-on-the-wire.md) | Worker pid in status and the registry | Done |
| [T-1004](../tasks/T-1004-control-socket-identity.md) | Connection identity on the control socket | Done |
| [T-1005](../tasks/T-1005-worker-env-allowlist.md) | Allowlist the worker environment | Done |
| [T-1006](../tasks/T-1006-in-process-worker-path.md) | In-process worker path for cheap agents | Planned |
