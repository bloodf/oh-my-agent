# EP-05 — Operator surface: daemon entry point and TUI

**Status:** Ready

## Outcome

A user can start the daemon, see what their agents are doing, and steer them from inside the OMP TUI.

## Why this is its own epic

Every runtime subsystem is built and tested, but nothing a user can launch or look at exists yet: the extension entry point is still an empty factory and there is no daemon binary. Until this epic lands the system is complete and unusable.

## In scope

- A `daemon` entry point that boots the broker, gateway, store, and supervisor.
- Peer store loading definitions from the private user and project paths.
- Toolbelt extension exposing chat and agent tools to workers.
- TUI commands, a status widget, and ask-dialogs.

## Not in scope

- Changing any runtime invariant already covered by EP-02 through EP-04.

## Acceptance

- [ ] `omp-agent daemon` starts, serves a socket, and survives its launching terminal closing.
- [ ] `/agents` lists peers with state, and shows a shield only for sandboxed ones.
- [ ] `/rooms` reads and posts as `@you`.
- [ ] A worker can call `chat_send` and `chat_wait` against the daemon's bus.

## Decisions

- [ADR-001](../adr/ADR-001-rpc-subprocess-workers.md) — Peers run as RPC subprocesses, not in-process sessions
- [ADR-005](../adr/ADR-005-sandbox-opt-in-fail-closed.md) — OS sandboxing is opt-in, and opting in fails closed

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-501](../tasks/T-501-peer-store.md) | Peer store: load definitions from the private paths | Ready |
| [T-502](../tasks/T-502-daemon-entry-point.md) | Daemon entry point | Ready |
| [T-503](../tasks/T-503-agent-toolbelt.md) | Worker toolbelt extension | Ready |
| [T-504](../tasks/T-504-tui-surface.md) | TUI commands, status widget, and dialogs | Ready |
| [T-505](../tasks/T-505-definition-staleness.md) | Rebuild a worker when its definition changes | Ready |
| [T-506](../tasks/T-506-metered-budget-wiring.md) | Wire metered budget warnings into rooms | Ready |
