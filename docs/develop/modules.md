# Module map

One-line purpose per file. Architecture context: [architecture.md](architecture.md). Spec: [ARCHITECTURE.md](../../ARCHITECTURE.md). Asset ownership: [`docs/delivery/asset-map.md`](../delivery/asset-map.md).

## `src/daemon/`

Long-running `omp-agent` process. Composition root, control socket, persistence, credentials, scheduling.

| File | Purpose |
|---|---|
| [`main.ts`](../../src/daemon/main.ts) | Composition root and `omp-agent` bin. Boots every subsystem, detaches, shuts down in reverse. |
| [`cli.ts`](../../src/daemon/cli.ts) | Shell client: JSON-RPC over the unix socket, no TUI required. |
| [`boot.ts`](../../src/daemon/boot.ts) | Broker hosting: reuse a discovered broker or embed one. Workers never see `adminToken`. |
| [`socket.ts`](../../src/daemon/socket.ts) | JSON-RPC control socket. TUI, CLI, and toolbelt reach the daemon only through this. |
| [`operations.ts`](../../src/daemon/operations.ts) | Shared kill, inject, logs tail, and budget bump for socket and console. |
| [`console-api.ts`](../../src/daemon/console-api.ts) | Loopback HTTP + WebSocket operator API and static console serving. |
| [`supervisor.ts`](../../src/daemon/supervisor.ts) | Wake filters, batched delivery, park/resume, definition-staleness respawn. |
| [`scheduler.ts`](../../src/daemon/scheduler.ts) | Cron and one-shot timers with an injectable clock. |
| [`db.ts`](../../src/daemon/db.ts) | SQLite write-through for agents, runs, and schedules. |
| [`peer-store.ts`](../../src/daemon/peer-store.ts) | Enumerate, parse, and write private user/project peer definitions. |
| [`materializer.ts`](../../src/daemon/materializer.ts) | Per-worker synthetic HOME, spawn-policy snapshot, inference wiring. |
| [`credential-gateway.ts`](../../src/daemon/credential-gateway.ts) | Per-worker scoped broker view and revocable bearer. |
| [`account-registry.ts`](../../src/daemon/account-registry.ts) | Per-account quota, wake gating, subscription auto-resume. |
| [`quota-state.ts`](../../src/daemon/quota-state.ts) | Metered/subscription state machine with generation guards. |

## `src/worker/`

RPC subprocess lifecycle and the tools injected into each peer.

| File | Purpose |
|---|---|
| [`lifecycle.ts`](../../src/worker/lifecycle.ts) | Start, prompt, park, resume, stop an RPC (or in-process) worker. `classifyAgentSpawn`. |
| [`toolbelt.ts`](../../src/worker/toolbelt.ts) | Nine daemon-backed tools (`chat_*`, `agent_*`, `task_handoff`) over the unix socket. |
| [`sandbox.ts`](../../src/worker/sandbox.ts) | Compile a typed policy to Seatbelt or `bwrap`; probe adapters. |
| [`launch-gate.ts`](../../src/worker/launch-gate.ts) | Fail-closed sandbox launch: probe, then wrap. Never degrade silently. |

## `src/rooms/`

| File | Purpose |
|---|---|
| [`store.ts`](../../src/rooms/store.ts) | SQLite rooms, threaded messages, reactions, mentions, subscriptions, read cursors. |

## `src/extension/`

OMP TUI plugin. Socket-only: no direct DB access.

| File | Purpose |
|---|---|
| [`index.ts`](../../src/extension/index.ts) | Extension factory: register commands and the status widget. |
| [`commands.ts`](../../src/extension/commands.ts) | `/agents`, `/rooms`, `/spawn`, `/kill`, inject, logs, schedule, edit. |
| [`widget.ts`](../../src/extension/widget.ts) | Daemon socket client and running/parked/unread status widget. |
| [`manager.ts`](../../src/extension/manager.ts) | Full-screen `/manage` tree: browse, edit, steer, kill. |

## `src/console/`

Vanilla JS, no build step. Bun serves these files as-is.

| File | Purpose |
|---|---|
| [`index.html`](../../src/console/index.html) | Console shell, operator-token prompt, landmarks. |
| [`app.js`](../../src/console/app.js) | Channels, transcript, composer, threads, reactions, live events. |
| [`style.css`](../../src/console/style.css) | Design tokens. Rules outside `:root` may only use `var()`. |

## `src/shared/`

Transport-free types and parsing.

| File | Purpose |
|---|---|
| [`protocol.ts`](../../src/shared/protocol.ts) | Versioned JSON-RPC method names, params, results, error builders. |
| [`protocol-schemas.ts`](../../src/shared/protocol-schemas.ts) | Runtime validation for every method's params and result. |
| [`agent-definition.ts`](../../src/shared/agent-definition.ts) | Parse markdown+YAML peers; reject unknown keys; fingerprint. |
| [`env-scrub.ts`](../../src/shared/env-scrub.ts) | Worker env allowlist and the selectors that must never be inherited. |

## Also in the repo

| Path | Purpose |
|---|---|
| [`agents/`](../../agents/) | Example peer definitions (`example-researcher`, `example-reviewer`). |
| [`skills/`](../../skills/) | OMP skills for agent authoring, subagent authoring, orchestration. |
| [`patches/`](../../patches/) | `RpcClient.pid` patch for the checkout. Does not travel to npm consumers. |
| [`scripts/gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py) | Source of `docs/delivery/`. |
| [`scripts/check-patches.py`](../../scripts/check-patches.py) | Patch-key / lockfile hygiene gate. |
| [`scripts/dogfood.ts`](../../scripts/dogfood.ts) | Live-session harness driven by `omp-agent --json`. |
| [`repro/bun-plugin-memo/`](../../repro/bun-plugin-memo/) | Minimal repro for the resolver defect behind T-1503. |

## `tests/`

| File | Covers |
|---|---|
| [`scaffold.test.ts`](../../tests/scaffold.test.ts) | Package manifest, `omp.extensions`, extension factory. |
| [`harness.test.ts`](../../tests/harness.test.ts) | Temp agent dir and fake broker fixtures. |
| [`build-hygiene.test.ts`](../../tests/build-hygiene.test.ts) | No `scripts.build`, no runtime `dependencies`. |
| [`agent-definition.test.ts`](../../tests/agent-definition.test.ts) | Parser, unknown-key rejection, fingerprints. |
| [`protocol.contract.test.ts`](../../tests/protocol.contract.test.ts) | Declared methods, params/result validation, error shape. |
| [`peer-store.test.ts`](../../tests/peer-store.test.ts) | Private store list/get/write; shipped examples. |
| [`materializer.test.ts`](../../tests/materializer.test.ts) | Synthetic HOME, generated definition, inference, path safety. |
| [`sandbox.test.ts`](../../tests/sandbox.test.ts) | Seatbelt/`bwrap` compile and adapter probe. |
| [`sandbox-gate.test.ts`](../../tests/sandbox-gate.test.ts) | Fail-closed launch gate. |
| [`seatbelt-wiring.test.ts`](../../tests/seatbelt-wiring.test.ts) | Profile matches materialized worker; gateway endpoint checks. |
| [`credential-gateway.test.ts`](../../tests/credential-gateway.test.ts) | Token issuance, snapshot filter, shared disable, usage isolation. |
| [`gateway-client.test.ts`](../../tests/gateway-client.test.ts) | Real `RemoteAuthCredentialStore` through the gateway. |
| [`account-registry.test.ts`](../../tests/account-registry.test.ts) | Block-driven resume, wake path, bookkeeping. |
| [`scheduler.test.ts`](../../tests/scheduler.test.ts) | Cron, one-shot timers, quota auto-resume. |
| [`rooms.test.ts`](../../tests/rooms.test.ts) | Lifecycle, post, threads, reactions, unread, persistence. |
| [`supervisor.test.ts`](../../tests/supervisor.test.ts) | Delivery, quota park, budget notifications, wake filters, staleness. |
| [`worker-lifecycle.test.ts`](../../tests/worker-lifecycle.test.ts) | Env allowlist, RPC lifecycle, §5.1 delegation, sandbox wiring, spawn classify. |
| [`worker-inprocess.test.ts`](../../tests/worker-inprocess.test.ts) | In-process backend invariants, run records, timer hygiene. |
| [`toolbelt.test.ts`](../../tests/toolbelt.test.ts) | Nine collaboration tools against a real socket. |
| [`daemon-boot.test.ts`](../../tests/daemon-boot.test.ts) | External vs embedded broker hosting. |
| [`daemon-main.test.ts`](../../tests/daemon-main.test.ts) | Composition, protocol errors, single instance, shutdown, detach. |
| [`daemon-persistence.test.ts`](../../tests/daemon-persistence.test.ts) | Restart survival, orphan sweep, run records. |
| [`daemon-hierarchy.test.ts`](../../tests/daemon-hierarchy.test.ts) | Parentage, inheritance, kill cascade, authoring verbs. |
| [`daemon-cli.test.ts`](../../tests/daemon-cli.test.ts) | Every CLI verb, `--json`, daemon stop/restart, console URL. |
| [`daemon-console-mount.test.ts`](../../tests/daemon-console-mount.test.ts) | Operator token, static serving, path containment, printed URL. |
| [`extension.test.ts`](../../tests/extension.test.ts) | Slash commands, widget, manager, editing, degradations. |
| [`console-api.test.ts`](../../tests/console-api.test.ts) | HTTP/WS API: channels, messages, attribution, ops, membership. |
| [`console-client.test.ts`](../../tests/console-client.test.ts) | Browser flows: render, post, threads, a11y, unread, remote auth. |
| [`socket-identity.test.ts`](../../tests/socket-identity.test.ts) | Bearer identity, attribution overwrite, worker scope, remote mode. |
| [`remote-exposure.test.ts`](../../tests/remote-exposure.test.ts) | Bind refusal, forwarded headers, origin, tickets, audit. |
| [`usage-meter.test.ts`](../../tests/usage-meter.test.ts) | Broker usage polling drives warn/park. |
| [`end-to-end.test.ts`](../../tests/end-to-end.test.ts) | Spawn → room message → native `task` → park → auto-resume. |
| [`skills.test.ts`](../../tests/skills.test.ts) | Skill discovery, frontmatter, materialization. |
| [`pack.test.ts`](../../tests/pack.test.ts) | `npm pack` allowlist and `prepack` wiring. |
| [`consumer-install.test.ts`](../../tests/consumer-install.test.ts) | Packed tarball installs via npm, Bun, and OMP and boots. |
| [`dogfood.test.ts`](../../tests/dogfood.test.ts) | Harness against a fixture daemon: refusals, polling, cleanup. |
| [`contracts/discovery.contract.test.ts`](../../tests/contracts/discovery.contract.test.ts) | OMP `discoverAgents` precedence; private store invisible. |
| [`contracts/broker.contract.test.ts`](../../tests/contracts/broker.contract.test.ts) | Real auth-broker snapshot, stream, block, refresh. |
| [`contracts/spawn-policy.contract.test.ts`](../../tests/contracts/spawn-policy.contract.test.ts) | OMP `resolveSpawnPolicy` / `isScoutSpawnable`. |
| [`contracts/supervisor-contract.test.ts`](../../tests/contracts/supervisor-contract.test.ts) | Shared lifecycle contract for both worker backends. |

### Fixtures

| File | Purpose |
|---|---|
| [`fixtures/temp-agent-dir.ts`](../../tests/fixtures/temp-agent-dir.ts) | Disposable agent dir, cleaned in `finally`. |
| [`fixtures/fake-broker.ts`](../../tests/fixtures/fake-broker.ts) | In-process loopback broker stand-in. |
| [`fixtures/hermetic-env.ts`](../../tests/fixtures/hermetic-env.ts) | Child env with config-root selectors stripped. |
| [`fixtures/control-client.ts`](../../tests/fixtures/control-client.ts) | Authenticated daemon-socket client (ADR-008 seam). |
