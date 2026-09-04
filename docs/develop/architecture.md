# Architecture tour

This is an onboarding pass for a new contributor. The design specification is [ARCHITECTURE.md](../../ARCHITECTURE.md). Read that as the spec: every section is marked Implemented, Partial, or Planned, and names production modules plus covering suites. Where the two documents disagree, [`docs/delivery/`](../delivery/README.md) wins.

## What you are looking at

oh-my-agent is an [OMP](https://omp.sh/docs) plugin. Peer definitions are markdown + YAML frontmatter, same shape as OMP task agents, stored in a **plugin-private** tree so they never leak into unrelated `/agents` hubs. A long-lived Bun process (`omp-agent daemon`) owns workers, rooms, schedules, and credentials. Closing a terminal does not stop it.

Three operator surfaces, one daemon:

- OMP TUI extension (`src/extension/`)
- `omp-agent` CLI (`src/daemon/cli.ts`, bin `src/daemon/main.ts`)
- Browser console (`src/console/` + `src/daemon/console-api.ts`)

## Data flow

![Runtime](../diagrams/runtime.svg)

TUI and CLI never touch SQLite. They send protocol methods defined in [`src/shared/protocol.ts`](../../src/shared/protocol.ts) over the control socket in [`src/daemon/socket.ts`](../../src/daemon/socket.ts). The browser talks HTTP and WebSocket to [`src/daemon/console-api.ts`](../../src/daemon/console-api.ts). Kill, inject, logs, and budget bump are one module ([`src/daemon/operations.ts`](../../src/daemon/operations.ts)) composed once in [`src/daemon/main.ts`](../../src/daemon/main.ts) and handed to both surfaces.

A typical turn:

1. Human posts in a room from TUI, CLI, or console.
2. [`RoomStore`](../../src/rooms/store.ts) persists the message, mentions, and thread parentage.
3. [`Supervisor`](../../src/daemon/supervisor.ts) matches wake filters, batches pending messages, and prompts the parked worker.
4. The worker is an OMP RPC subprocess started by [`src/worker/lifecycle.ts`](../../src/worker/lifecycle.ts) inside a materialized root from [`src/daemon/materializer.ts`](../../src/daemon/materializer.ts).
5. Worker tools (`chat_send`, `agent_spawn`, ...) in [`src/worker/toolbelt.ts`](../../src/worker/toolbelt.ts) call the same unix socket. Coding subtasks go through native `task`, never `agent_spawn` ([ADR-007](../delivery/adr/ADR-007-native-task-delegation.md)).

![Worker lifecycle](../diagrams/worker-lifecycle.svg)

## Boot path

[`bootDaemon`](../../src/daemon/main.ts) is the composition root:

1. Refuse a live pidfile for the same agent dir (`PI_CODING_AGENT_DIR`, else OMP `getAgentDir()`).
2. Resolve broker hosting: reuse a discovered broker, or embed one ([`src/daemon/boot.ts`](../../src/daemon/boot.ts)).
3. Start the scoped credential gateway ([`src/daemon/credential-gateway.ts`](../../src/daemon/credential-gateway.ts)). Workers never see the vault-wide token.
4. Open SQLite (daemon db + room store), peer store, supervisor, scheduler.
5. Serve the control socket and, unless `OMA_CONSOLE=0`, the console API.
6. Detach from the launching TTY.

Invalid remote-exposure config fails before the pidfile or any listener.

## Isolation

Three layers, decreasing strength. Full argument: [ARCHITECTURE.md §7](../../ARCHITECTURE.md) and [ADR-005](../delivery/adr/ADR-005-sandbox-opt-in-fail-closed.md).

| Layer | What it is | What it is not |
|---|---|---|
| OS sandbox (`sandbox: true`) | macOS Seatbelt / Linux `bwrap`. Opt-in. Missing adapter fails closed. | Default. Linux cannot enforce loopback ports without `unrestricted-host-network`. |
| Write isolation | OMP `task.isolation.mode` for delegated coding subagents | A read boundary |
| Convention scoping | Tool allowlists, generated worker config, instructions | Security |

**`workspace:` scopes defaults, not access.** It sets cwd and project discovery. It does not stop a worker reading `~/.ssh`. `/agents` shows a shield only for sandboxed peers.

## Credentials and quota

Each worker gets a bearer bound to one account. The gateway filters snapshot, refresh, block, and usage to those ids ([ADR-003](../delivery/adr/ADR-003-scoped-credential-gateway.md)). Quota is an account property, not a peer property ([ADR-006](../delivery/adr/ADR-006-account-level-quota-parking.md)): metered accounts warn at 80% of `budgetUsd` and park at 100%; subscription accounts park on a quota block and auto-resume from `blockedUntilMs`.

## Attribution

Console posts as the human. Worker chat methods have attribution overwritten with the authenticated peer name. The operator token keeps full override ([ADR-014](../delivery/adr/ADR-014-attribution-policy.md)).

## Decisions worth reading before you edit

| ADR | Why it constrains your change |
|---|---|
| [ADR-001](../delivery/adr/ADR-001-rpc-subprocess-workers.md) | Production workers are RPC subprocesses |
| [ADR-002](../delivery/adr/ADR-002-private-store-materialized-roots.md) | Definitions live in a private store, materialized per worker |
| [ADR-008](../delivery/adr/ADR-008-tests-share-production-builders.md) | Tests share production builders |
| [ADR-010](../delivery/adr/ADR-010-mit-license.md) | MIT |
| [ADR-012](../delivery/adr/ADR-012-remote-exposure.md) | Daemon never terminates TLS; proxy in front |
| [ADR-013](../delivery/adr/ADR-013-release-channel.md) | One npm package; consumers get an unpatched peer until T-1504 |
| [ADR-015](../delivery/adr/ADR-015-typed-daemon-events.md) | State changes are typed frames |

The full set is [`docs/delivery/adr/`](../delivery/adr/). If a change contradicts an accepted ADR, the ADR is part of the change.
