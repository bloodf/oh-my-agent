# oh-my-agent — Architecture

An [oh-my-pi (OMP)](https://omp.sh/docs) plugin that runs **autonomous, long-lived agents** which keep working while you're away, talk to each other in chat rooms, and are fully observable/steerable from inside the interactive OMP TUI.

Status: design. Everything here is grounded in verified OMP surfaces (docs + `dist/types` of the installed `@oh-my-pi/pi-coding-agent`), not guesses.

---
> **Status: this document is a design specification, not a description of shipped code.**
>
> Sections below describe the intended system in present tense. Some of it is
> built and tested; some is not written yet. Every subsection carries an
> explicit marker:
>
> - **[Implemented]** — code exists and is covered by tests. The marker names the module and its suite.
> - **[Partial]** — some of the described behavior exists; the marker says what is missing.
> - **[Planned]** — no implementation yet. The marker names the delivery task that would build it.
>
> Current build: 402 tests across 18 files. The runtime is largely built; the
> operator surface (daemon binary, control socket, toolbelt, TUI) is not. See
> [`docs/delivery/README.md`](docs/delivery/README.md) for the task-level state,
> and treat that tree as authoritative when it disagrees with this document.


## 1. Goals

- **Autonomy** — agents run without a TUI attached; closing your terminal does not stop them.
- **Multi-agent collaboration** — agents communicate through persistent chat rooms (channels + DMs), with mention-based wakeups.
- **Native OMP feel** — agents are defined the same way OMP task agents are (markdown + YAML frontmatter); the plugin installs as a normal OMP extension package.
- **Observability** — from any OMP session: list agents, tail their work, join their rooms, inject instructions, kill/restart them.
- **Scheduling** — cron-style automations that spawn or wake agents.

## 2. Non-goals

- Not a security sandbox (see §7 — this is important and easy to get wrong).
- Not a general workflow engine; agents are OMP sessions, orchestration stays thin.
- No cloud component. Everything is local: Bun + SQLite + unix sockets.

---

## 3. What OMP gives us (verified)

| Surface | What we use it for |
|---|---|
| **Extension API** — default-export factory `(pi: ExtensionAPI) => void`; `registerTool`, `registerCommand`, `on(...)` events, `sendMessage` / `sendUserMessage` / `appendEntry`, ask dialogs, widgets, custom renderers | The in-TUI control plane: slash commands, status widget, chat viewer, agent tools |
| **Register-then-run constraint** — action methods throw `ExtensionRuntimeNotInitializedError` during load | All runtime behavior lives in event/command/tool handlers |
| **SDK** — `createAgentSession`, `SessionManager`, `Settings`, `AuthStorage`, `ModelRegistry`, `AgentRegistry`, discovery helpers; `session.subscribe(event)`, `session.prompt(...)`, `session.dispose()`; requires Bun ≥ 1.3.14 | The daemon embeds agent sessions in-process |
| **RPC mode** — typed client (`dist/types/modes/rpc/rpc-client.d.ts`), frame protocol, subagent subscription levels (`RpcSubagentLifecycleFrame`, `RpcSubagentProgressFrame`, `setSubagentSubscription`) | Subprocess workers when crash isolation matters |
| **Task agent discovery** — `~/.omp/agent/agents/*.md` with frontmatter: `name`, `description`, `model` (incl. `@role` aliases via `modelRoles`), `tools`, `prewalk`, `advisor`; overridable via `task.agentModelOverrides` | We reuse the exact same format + roots for agent definitions |
| **Extension loading roots** — `<cwd>/.omp/extensions`, active agent dir `extensions/`, `package.json#omp.extensions` plugin manifests, `config.yml` `extensions:` | How oh-my-agent installs |
| **Task isolation** — `task.isolation.mode`: `none` / `worktree` / `fuse-overlay` / `overlayfs` / `rcopy` / `projfs`; copy-on-write workspace, merge back on completion | **Write** isolation for agent workspaces (not a security boundary) |

## 4. Component architecture

*The diagram below shows the intended whole. Two of its five boxes do not exist
yet: the daemon process and the TUI extension. Each subsection carries its own
marker.*

```
┌────────────────────────────── omp (interactive TUI) ──────────────────────────────┐
│  oh-my-agent extension                                                            │
│  /agents /rooms /spawn /kill …   status widget   chat renderer   notifications    │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ JSON-RPC over unix socket (~/.omp/agent/oh-my-agent/daemon.sock)
┌───────────────▼───────────────── omp-agent daemon (Bun) ──────────────────────────┐
│  Supervisor      Scheduler (cron/automations)      Bus (rooms/channels/DMs)       │
│  SQLite (state, messages, runs, schedules)                                        │
│      │ spawns & owns                                                              │
│      ├── worker: agent "researcher"   (OMP session)                               │
│      ├── worker: agent "reviewer"     (OMP session)                               │
│      └── worker: agent "ops"          (OMP session)                               │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Daemon — [Planned]

*No daemon binary exists: `package.json` declares no `bin`, and no module boots the
subsystems together. Delivery task [T-502](docs/delivery/tasks/T-502-daemon-entry-point.md).
Broker hosting resolution is built ([`src/daemon/boot.ts`](src/daemon/boot.ts),
`tests/daemon-boot.test.ts`, 14 tests).*

- `omp-agent daemon` — long-running Bun process, detached from any TTY; **this** is what "keeps working while I'm away" means.
- Single instance per user profile; socket + pidfile under the active agent dir (honors `PI_CODING_AGENT_DIR` / `--profile`).
- Owns all durable state (SQLite via `bun:sqlite`): agents, runs, room messages, schedules, delivery cursors.

### 4.2 Workers (agent runtimes) — [Partial]

*RPC subprocess workers are built ([`src/worker/lifecycle.ts`](src/worker/lifecycle.ts),
`tests/worker-lifecycle.test.ts`, 22 tests), including park, resume, and the §5.1
delegation invariant proven against a real child. The in-process optimization path
and the agent toolbelt are not written: no `chat_send`, `chat_read`, `chat_wait`,
`agent_status`, or `task_handoff` exists in `src/`. Toolbelt is delivery task
[T-503](docs/delivery/tasks/T-503-agent-toolbelt.md).*

- Default: **subprocess per agent** in RPC mode — crash isolation, per-agent env/cwd, daemon supervises restarts with backoff.
- Optimization path: in-process `createAgentSession` for cheap/short-lived agents. Same worker interface either way.
- Each worker gets the oh-my-agent **agent toolbelt** injected as an extension: `chat_send`, `chat_read`, `chat_wait` (block until mention/new message), `agent_spawn` (create a long-lived **peer** agent in the daemon — never for coding subtasks, see §5.1), `agent_status`, `task_handoff`.

### 4.3 Bus (chat rooms) — [Partial]

*The store is built ([`src/rooms/store.ts`](src/rooms/store.ts), `tests/rooms.test.ts`,
25 tests) with `rooms`, `messages`, and `subscriptions` tables. Subscription-scoped
delivery and wake are built ([`src/daemon/supervisor.ts`](src/daemon/supervisor.ts),
`tests/supervisor.test.ts`, 13 tests). Mention parsing and per-agent wake filters are
not implemented: `wake` is parsed from a definition but nothing consumes it. Humans
cannot post, because the TUI does not exist.*

- Rooms = channels (`#general`, `#reviews`, …) and DMs (`@researcher`). SQLite-backed, append-only messages with per-agent read cursors.
- Wakeups: a parked (idle) agent is resumed by the daemon when it is `@mentioned` or a room it subscribes to gets a message matching its wake filter — the daemon calls `session.prompt()` / RPC prompt with the pending messages batched into one turn.
- Humans are first-class participants: the TUI extension posts into rooms as `@you`.

### 4.4 Scheduler — [Partial]

*Cron evaluation and one-shot timers are built ([`src/daemon/scheduler.ts`](src/daemon/scheduler.ts),
`tests/scheduler.test.ts`, 47 tests), including Vixie DOM/DOW semantics, and drive
quota auto-resume. Schedules are held in memory, not SQLite, and nothing arms a
definition's `schedules:` or `automations:` blocks — the parser accepts them and no
consumer reads them. Arming belongs to [T-502](docs/delivery/tasks/T-502-daemon-entry-point.md).*

- Cron expressions + one-shot timers stored in SQLite; on fire → spawn agent or post a message into a room (which may wake subscribers).
- Automations are markdown too: prompt body + `schedule:` frontmatter.

### 4.5 TUI extension — [Planned]

*[`src/extension/index.ts`](src/extension/index.ts) is a five-line no-op factory. No
command, widget, renderer, or socket client exists. Delivery task
[T-504](docs/delivery/tasks/T-504-tui-surface.md), which depends on the daemon socket
from T-502.*

- Slash commands: `/agents` (hub: list/spawn/kill/logs), `/rooms` (join/read/post), `/schedule`.
- Status widget: running/parked agent count, unread room messages.
- Custom renderer for room transcripts; ask-dialogs for confirmations.
- Talks **only** to the daemon socket — no direct DB access, so the TUI and daemon can't race.

## 5. Agent definitions — [Implemented]

*[`src/shared/agent-definition.ts`](src/shared/agent-definition.ts), covered by
`tests/agent-definition.test.ts` (59 tests). Note one deviation from the text
below: an unknown key raises `PeerParsingError` at parse time rather than warning
at spawn, because a silently tolerated typo in `sandbox:` is an unenforced policy.*

Definitions use OMP's task-agent format verbatim — but they are **not** stored in OMP's discovery roots. `~/.omp/agent/agents/` is global: OMP merges it into every session, so parking peer definitions there would surface them in the `/agents` hub of every unrelated OMP session. See §5.2 for where they actually live.

```markdown
---
name: reviewer
description: Reviews PRs and posts findings to #reviews.
model: "@review"          # resolved via modelRoles, e.g. review: openai/gpt-5.4:high
tools: [task, read, grep, chat_send, chat_read]   # keep `task` — see §5.1
spawns: [scout, implementor]                      # in-run delegation allowlist
workspace: ~/work/acme    # cwd for the worker — see §7 for what this does and does NOT mean
rooms: ["#reviews"]       # oh-my-agent additions live under plain keys OMP ignores
wake: { mention: true }
autonomy: { max_turns: 40, budget_usd: 2.50 }
---
You are the code reviewer for this team. When woken with new messages…
```

OMP-known keys behave identically to native task agents (so definitions stay portable); oh-my-agent reads its extra keys (`rooms`, `wake`, `autonomy`, `workspace`, `sandbox`) and ignores none silently — unknown keys warn at spawn.

### 5.1 Delegation contract (worker agents are orchestrators) — [Implemented]

*[`src/worker/lifecycle.ts`](src/worker/lifecycle.ts) (`classifyAgentSpawn`),
pinned by `tests/contracts/spawn-policy.contract.test.ts` (23 tests) and proven
against a real child in `tests/end-to-end.test.ts`. The `agent_spawn` rejection
described below is specified but unbuilt, because no toolbelt exists yet
([T-503](docs/delivery/tasks/T-503-agent-toolbelt.md)); the classifier it would
call is built and tested.*

A top-level worker agent's job is to **coordinate**, and in OMP coordination means the native `task` tool. An explicit `tools:` list *replaces* the default set — write it naively and you silently strip `task`, leaving the agent unable to spawn subagents at all. The contract:

- **Every worker agent keeps native delegation.** Either include `task` in `tools:` or declare `spawns:` — OMP auto-adds `task` to a restricted tool list when `spawns:` is declared and depth permits (`runSubprocess`). Declaring `spawns: [a, b]` is preferred: it doubles as the allowlist, and an omitted `agent` field in a dispatch defaults to the first listed entry. (`tools: [task]` without `spawns:` implies `spawns: *` via backward-compat.)
- **Two spawn verbs, two meanings.** Native `task` = in-run subagent (bounded, transcript folds into the parent run, subject to spawn policy). `agent_spawn` toolbelt = new long-lived peer in the daemon (own lifecycle, rooms, budget). Coding/research subtasks MUST dispatch through native `task`; `agent_spawn` is reserved for standing up durable teammates. The toolbelt tool description states this and the daemon rejects `agent_spawn` calls whose payload looks like a one-shot subtask (has `expected_output`, no `rooms`).
- **Recursion & approval policy is OMP's, inherited.** Depth is governed by `task.maxRecursionDepth` (default `2`; at the cap OMP strips `task` and empties the spawn policy), self-recursion by the `PI_BLOCKED_AGENT` guard, and per-agent bans by `task.disabledAgents`. oh-my-agent adds nothing on top except `autonomy.max_turns`/`budget_usd` at the run level — one policy system, not two.
- **Tested invariant.** The integration suite runs a worker with a restricted `tools:` list, has it perform a coding task, and asserts (a) the effective tool list contains `task`, (b) at least one dispatch went through native `task`, (c) zero `agent_spawn` calls occurred during the run.

### 5.2 Private store + materialized worker dirs (no global leakage) — [Partial]

*Materialization is built ([`src/daemon/materializer.ts`](src/daemon/materializer.ts),
`tests/materializer.test.ts`, 30 tests) including the synthetic root, the `spawns:`
closure, the `task.disabledAgents` snapshot, and atomic swap with restore. Reading
definitions from the two private store paths is not: nothing enumerates them
([T-501](docs/delivery/tasks/T-501-peer-store.md)). Startup orphan sweep is also
unbuilt.*

- **Source of truth is plugin-private.** Peer definitions live in `~/.omp/agent/oh-my-agent/agents/*.md` (user) and `<project>/.omp/oh-my-agent/agents/*.md` (project). Neither path is an OMP discovery root, so normal OMP sessions never see them. A user who *wants* a definition available to plain OMP copies it into the global root explicitly.
- **Materialize per worker at spawn.** The daemon builds a synthetic user root per worker under `~/.omp/agent/oh-my-agent/workers/<agent>/home/`. It owns `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`; the canonical OMP agent dir is `<home>/.omp/agent`, and its `agents/` contains only the worker's own definition plus definitions named by `spawns:`. This is required because `discoverAgents()` consults generic native config roots as well as `getAgentDir()`; `PI_CODING_AGENT_DIR` alone does not reroot both. The dir starts with no `agent.db`; never seed it from the user's credential store.
- **Wire-up per worker mode.** RPC workers launch with all five synthetic user-root variables plus `PI_CODING_AGENT_DIR=<home>/.omp/agent` and blank default-profile selectors. They receive no upstream broker/provider credentials. The daemon first exposes the worker's account-filtered broker protocol through the scoped credential gateway (§9.6), then creates a per-worker OMP auth-gateway whose `RemoteAuthCredentialStore` connects **only to that scoped endpoint/token**. Worker-local `models.yml` sets `transport: pi-native`, the inference-gateway `baseUrl`, and its separate per-worker inference bearer; model turns flow `worker → pi-native inference gateway → scoped credential gateway → upstream broker/provider`. The inference gateway never receives the vault-wide broker token or an unfiltered snapshot. Sandboxed MCP/network tools likewise require declared loopback host bridges. Process cwd remains the assigned project for project `.omp/agents` discovery. Contract tests must prove both credential filtering and pi-native model routing.
- **`spawns:` policy is the enforcement — materialization is not.** Discovery precedence (`discoverAgents`, `src/task/discovery.ts`) consults the nearest project `.omp/agents` *before* the active agent dir, and extension + bundled roots after it. Workers keep the project `cwd` (they edit the project tree), so an unmaterialized project agent — or any extension/bundled agent — remains discoverable regardless of what the worker dir contains. Materialization only curates the user-root slice; the actual allowlist is §5.1's `spawns:` policy, checked at dispatch time. As defense-in-depth, at spawn the daemon snapshots `discoverAgents(workerCwd)` and writes every discovered name outside the worker's allowlist into the worker's `task.disabledAgents` — a static deny-list (filtered after discovery, preflight-enforced at dispatch): agents appearing after spawn stay enabled until the next materialization, so it hardens listings but never replaces `spawns:`.
- **Cleanup.** Materialized dirs are ephemeral; the daemon rebuilds them on every spawn (definitions may have changed) and sweeps orphans at startup.

## 6. Persistence (SQLite sketch) — [Partial]

*Built: `rooms`, `messages`, and `subscriptions` (the `cursors` role, folded into
`subscriptions.last_read_id`) in [`src/rooms/store.ts`](src/rooms/store.ts),
covered by `tests/rooms.test.ts` (25 tests). Not built: `agents`, `runs`, and
`schedules`. Agent and schedule state currently lives in memory inside the
supervisor, registry, and scheduler, so nothing survives a restart yet; run
history has no storage at all. Persisting these belongs to
[T-502](docs/delivery/tasks/T-502-daemon-entry-point.md).*

```
agents(name, definition_path, status, worker_pid, cwd, started_at, …)
runs(id, agent, trigger, started_at, ended_at, outcome, cost_usd, transcript_ref)
rooms(id, kind)                      -- channel | dm
messages(id, room_id, author, body, created_at)
cursors(agent, room_id, last_msg_id)
schedules(id, cron, action, payload, next_fire_at, enabled)
```

## 7. Isolation and security model — read this before assuming anything — [Implemented]

*Layer 1 is built: [`src/worker/sandbox.ts`](src/worker/sandbox.ts) compiles the
policy (51 tests), [`src/worker/launch-gate.ts`](src/worker/launch-gate.ts) fails
closed (13 tests), and `tests/seatbelt-wiring.test.ts` verifies the profile against
the materialized layout (10 tests). Layers 2 and 3 are OMP's own behavior, inherited.
The `/agents` shield described at the end of this section is [Planned] with the TUI
([T-504](docs/delivery/tasks/T-504-tui-surface.md)).*

This section is deliberately blunt because the intuitive mental model is wrong.

**`workspace:` (the worker's `cwd`) scopes *defaults*, not *access*.** Setting an agent's cwd to `DIR A` controls project discovery (`.omp/` config, skills, context files), relative-path resolution, and which repo the agent *thinks* it's in. It does **not** prevent the agent from reading `/etc/passwd`, `~/.ssh/`, or `../other-project`. OMP's own docs are explicit that extensions and tools are **not sandboxed** and run with full user permissions.

Three distinct layers, in decreasing strength:

1. **OS-level sandbox (the only real filesystem boundary).** Optional `sandbox: true` wraps the RPC subprocess: macOS Seatbelt and Linux `bwrap`. Sandboxed model traffic is routed through the daemon's per-worker pi-native auth-gateway on loopback; the worker never needs direct provider/broker access. Additional networked MCPs or automations must be exposed through declared daemon host bridges/loopback ports. Missing bridges fail closed instead of silently granting outbound network.
2. **Write isolation (mergeability, not security).** OMP `task.isolation.mode` gives delegated coding subagents copy-on-write workspaces and controlled merge-back. It does not restrict reads by itself.
3. **Convention scoping (soft, bypassable).** Tool allowlists, generated worker config, and system instructions reduce accidents when `sandbox` is off. They are never described as security isolation.

Defaults: layer 2 + 3 on, layer 1 opt-in (it constrains tooling and needs per-OS setup). `/agents` shows a shield icon only for sandboxed agents so the actual guarantee is visible.

## 8. Repo layout — [Partial]

*`src/daemon/`, `src/worker/`, `src/shared/`, and `tests/` exist as shown.
`src/extension/` holds only a no-op factory, there is no socket server in
`src/daemon/`, no toolbelt in `src/worker/`, and no `agents/` example directory
yet.*

```
oh-my-agent/
  package.json            # omp.extensions manifest → installs the TUI extension
  src/
    extension/            # in-TUI plugin (commands, widget, renderers)
    daemon/               # supervisor, scheduler, bus, sqlite, socket server
    worker/               # worker bootstrap + agent toolbelt extension
    shared/               # JSON-RPC protocol types, agent-definition parsing
  agents/                 # example agent definitions
  tests/                  # unit, integration, and OMP contract suites
```

## 9. Decisions (confirmed) — [Implemented, except where noted]

*Decisions 1, 3, 4, and 6 are built and tested. Decision 2 (per-worker gateway
tokens) is built at the gateway; the worker side that would consume it is not
wired, because no daemon composes them ([T-502](docs/delivery/tasks/T-502-daemon-entry-point.md)).
Decision 5 (no phased delivery) describes intent, and is not yet met: the
operator surface is unbuilt.*

1. **Worker mode:** RPC subprocess is the default; in-process SDK sessions are for tests and daemon-internal tooling only (§5.2).
2. **RPC worker auth:** every worker connects to the daemon's scoped credential gateway with its own revocable bearer token; only the daemon can access the upstream broker with the vault-wide token (§9.6).
3. **Discovery hygiene:** `spawns:` is the enforcement; enumerated `task.disabledAgents` snapshot at spawn as defense-in-depth (§5.2).
4. **Budget & quotas:** billing is a property of the **account**, not the agent. *Metered* (API-key) accounts: warn in the room at 80% of `budget_usd`, park at 100%; a human resumes with a bump or kills. *Subscription* accounts: no dollar cap — on a quota-exhaustion signal, every run on that account parks and the daemon schedules auto-resume at quota reset via a one-shot timer (§4); work continues with no human in the loop. `budget_usd` in agent frontmatter is metered-only; quota state is tracked per account in the daemon's account registry beside the broker.
5. **Delivery & method:** no phased delivery — the first shipped version has everything working (daemon, broker, rooms/bus, scheduler, materialization, sandboxing, quota handling), built test-first (§11).
6. **Broker hosting: discover, else embed - fronted by a per-worker gateway.** At boot the daemon runs the client discovery chain (`OMP_AUTH_BROKER_URL` env → `auth.broker.*` config → token file). Admin-token sourcing differs by mode: *external broker reused* → authenticate with the discovered token, treat it read-only, never rotate it; *embedded* → run `startAuthBroker` over the shared vault with a fresh in-memory admin token generated at boot. Workers receive only per-worker gateway tokens bound to one account. The gateway rewrites all upstream generations into a monotonically increasing **worker-view generation** and filters `GET /v1/snapshot`, `GET /v1/snapshot/stream`, refresh, block, and usage data to bound credentials. Foreign-id access, credential upload, and `/v1/usage/clients` are admin-only. Usage routes required by stock `RemoteAuthCredentialStore` remain compatible: observed usage is attributed to the worker; aggregate/history responses are account-filtered; stale notification is allowed. **Shared disable reconciliation is explicit:** `RemoteAuthCredentialStore.deleteAuthCredential()` removes locally before its fire-and-forget disable request and streaming clients skip pull refresh. For a dedicated account, the gateway proxies disable and returns the upstream result. For a shared account, the gateway (a) queues an idempotent policy request containing the route credential id and gateway-token worker identity, (b) returns retryable `409 {"status":"pending_policy","requestId":"…"}`, (c) leaves upstream state unchanged, (d) increments only the requester's worker-view generation, and (e) immediately emits a valid full filtered `snapshot` SSE event to that worker's active stream; conditional long-poll uses the same synthetic generation bump. `RemoteAuthCredentialStore` accepts a full snapshot when its generation is not older (`remote-store.ts:499-512`), restoring the locally removed credential. Peers remain unchanged. After approval, the daemon disables upstream and normal gateway events converge every worker. Embedded lifecycle mirrors `runServe` (`auth-broker-cli.ts:154-194`): open `SqliteAuthCredentialStore` → `AuthStorage.reload()` → `startAuthBroker`, loopback-only ephemeral bind; shutdown revokes worker tokens, closes gateway, then closes embedded handle/storage. Reused external brokers are never closed or mutated except through approved credential operations.

## 10. Open questions

1. ~~Transcript storage~~ **Resolved.** OMP's persisted session JSONL remains the canonical full transcript; oh-my-agent stores only `session_file`/byte cursor, run outcome, room projection ids, and optional deterministic search/index metadata in SQLite. On-demand replay reads OMP JSONL through its RPC/session APIs. No duplicate full-message blobs and no LLM-generated digest store.
2. ~~Sandbox policy shipping~~ **Resolved.** One typed workspace policy compiles to macOS Seatbelt or Linux `bwrap`. macOS enforces filesystem roots plus declared loopback gateway/host-bridge ports. Linux `bwrap --share-net` cannot enforce port-level loopback, so sandbox mode fails closed unless the agent explicitly accepts `unrestricted-host-network`; that downgrade is visible in `/agents`. Unsupported/missing adapters fail closed. Contract tests validate generated profiles/argv without launching privileged sandboxes.
3. ~~Materialized-dir staleness~~ **Resolved.** The daemon fingerprints the effective peer definition plus the materialized `spawns:` closure. Before every wake/scheduled run it recomputes that fingerprint. Match → reuse the parked worker; mismatch → stop/park the old RPC process, rebuild the worker dir and static `task.disabledAgents` snapshot, then start a fresh OMP session before delivering messages. No hot-reload protocol: policy-changing files never mutate under a live process.
4. ~~Broker surface~~ **Resolved** → §9.6. Server is exported (`startAuthBroker`, HTTP+SSE, bearer auth, ArkType wire schemas); embedding template is `runServe` (`auth-broker-cli.ts:154-194`) over local SQLite; discovery precedence verified in `auth-broker-config.ts`.
5. ~~Quota-signal producer~~ **Resolved.** `AuthStorage.rotateSessionCredential()` detects usage-limit/account-rate-limit outcomes (`auth-storage.ts:6429`), extracts provider retry hints, and calls `markUsageLimitReached()` (`:6433-6442`). That method computes `blockedUntil` from the hint plus an OAuth usage-report reset window (`:4544-4557`), then `#markCredentialBlocked()` persists `{credentialId, providerKey, blockScope, blockedUntilMs}` through the credential store (`:1888-1916`). With broker-backed workers, `RemoteAuthCredentialStore.upsertCredentialBlock()` posts the same block to `/v1/credential/:id/block`; snapshots expose the deadline. Subscription auto-resume schedules from this verified `blockedUntilMs`; providers without a parseable reset use OMP's retry-hint/default-backoff path rather than a custom oh-my-agent parser.

## 11. Engineering practice — [Implemented]

*Followed throughout: 402 tests across 18 files, `tsc --noEmit` clean. Two
practices were added after this document was written, both from defects found in
review: every regression test is proven non-vacuous by reverting the fix and
confirming failure, and a test that asserts on a construction production performs
must call the same builder rather than rebuilding it (see
[ADR-008](docs/delivery/adr/ADR-008-tests-share-production-builders.md)).*

- **TDD, strictly:** red → green → refactor. A failing test precedes every behavior; no daemon, broker, scheduler, or extension code lands without one.
- **Unit tests** colocated per module (`bun test`): protocol types, definition parsing, materialization, spawn-policy snapshots, quota state machine, room routing.
- **Integration suite** for cross-component invariants. Built: the §5.1 delegation invariant; broker round-trip through the gateway; foreign ids return 403; shared disable returns `409 pending_policy`, queues `{credentialId, workerId}`, emits a full snapshot with a newer worker-view generation, and leaves peers usable; dedicated disable proxies upstream; usage routes return account-filtered data; quota-park → auto-resume; end-to-end room message flow through the bus. **Not yet built:** proving a real `RemoteAuthCredentialStore` restores the credential it removed locally — the gateway suites drive the wire with `fetch`, so the client's reaction to that response is inferred from upstream source rather than exercised ([T-303](docs/delivery/tasks/T-303-client-integration.md)).
