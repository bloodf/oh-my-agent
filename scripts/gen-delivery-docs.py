#!/usr/bin/env python3
"""Generate the oh-my-agent delivery tree.

One generator, one contract. Hand-written unit files diverge by file three;
this keeps 40+ documents structurally identical and makes a contract change a
one-line edit.

Run: python3 scripts/gen-delivery-docs.py
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DELIVERY = os.path.join(ROOT, "docs", "delivery")

# ── Contract ──────────────────────────────────────────────────────────────────


@dataclass
class Task:
    id: str
    slug: str
    title: str
    epic: str
    sprint: str
    status: str  # Done | Ready | Blocked
    goal: str
    read_first: list[tuple[str, str]]
    files: list[str]
    assets: list[tuple[str, str, str]]  # (path, role, note)
    steps: list[str]
    acceptance: list[str]
    out_of_scope: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    unblocks: list[str] = field(default_factory=list)
    evidence: list[tuple[str, str]] = field(default_factory=list)  # (claim, anchor)


@dataclass
class Epic:
    id: str
    slug: str
    title: str
    status: str
    outcome: str
    why: str
    scope: list[str]
    non_goals: list[str]
    acceptance: list[str]
    adrs: list[str] = field(default_factory=list)


@dataclass
class Sprint:
    id: str
    slug: str
    title: str
    status: str
    theme: str


@dataclass
class ADR:
    id: str
    slug: str
    title: str
    status: str
    context: str
    decision: str
    consequences: list[str]
    alternatives: list[tuple[str, str]]  # (option, why rejected)
    evidence: list[tuple[str, str]]


def rel(depth: int, path: str) -> str:
    """Link from a file `depth` levels under docs/delivery to a repo path."""
    return "../" * depth + path


def table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def render_task(t: Task) -> str:
    d = 3  # docs/delivery/tasks/x.md -> repo root
    parts: list[str] = [f"# {t.id} — {t.title}", ""]
    parts.append(
        table(
            ["Epic", "Sprint", "Status", "Map"],
            [
                [
                    f"[{t.epic}](../epics/{EPIC_FILE[t.epic]})",
                    f"[{t.sprint}](../sprints/{SPRINT_FILE[t.sprint]})",
                    t.status,
                    "[asset-map](../asset-map.md)",
                ]
            ],
        )
    )
    parts += ["", "## Goal", "", t.goal, "", "## Read first", ""]
    for label, path in t.read_first:
        parts.append(f"- [{label}]({rel(d, path) if not path.startswith('http') else path})")
    parts += ["", "## Files this task may change", ""]
    for f in t.files:
        parts.append(f"- `{f}`")
    parts += ["", "## Modules and assets in play", ""]
    rows = []
    for p, role, note in t.assets:
        exists = os.path.exists(os.path.join(ROOT, p))
        cell = f"[`{p}`]({rel(d, p)})" if exists else f"`{p}` (to be created)"
        rows.append([cell, role, note])
    parts.append(table(["Path", "Role", "Note"], rows))
    parts += ["", "## Steps", ""]
    for i, s in enumerate(t.steps, 1):
        parts.append(f"{i}. {s}")
    parts += ["", "## Acceptance", ""]
    for a in t.acceptance:
        box = "x" if t.status == "Done" else " "
        parts.append(f"- [{box}] {a}")
    if t.evidence:
        parts += ["", "Evidence:", ""]
        ev_rows = []
        for c, anchor in t.evidence:
            p = anchor.split(":")[0]
            linkable = "/" in anchor and os.path.exists(os.path.join(ROOT, p))
            ev_rows.append([c, f"[`{anchor}`]({rel(d, p)})" if linkable else f"`{anchor}`"])
        parts.append(table(["Claim", "Anchor"], ev_rows))
    parts += ["", "## Out of scope", ""]
    parts += [f"- {x}" for x in (t.out_of_scope or ["Nothing deferred."])]
    parts += ["", "## Depends on", ""]
    parts += [f"- {x}" for x in (t.depends_on or ["Nothing."])]
    parts += ["", "## Unblocks", ""]
    parts += [f"- {x}" for x in (t.unblocks or ["Nothing."])]
    return "\n".join(parts) + "\n"


def render_epic(e: Epic, tasks: list[Task]) -> str:
    parts = [f"# {e.id} — {e.title}", "", f"**Status:** {e.status}", "", "## Outcome", "", e.outcome]
    parts += ["", "## Why this is its own epic", "", e.why, "", "## In scope", ""]
    parts += [f"- {x}" for x in e.scope]
    parts += ["", "## Not in scope", ""]
    parts += [f"- {x}" for x in e.non_goals]
    parts += ["", "## Acceptance", ""]
    for a in e.acceptance:
        parts.append(f"- [{'x' if e.status == 'Done' else ' '}] {a}")
    if e.status == "In progress":
        parts += ["", "Unchecked items above are covered by the Ready tasks below."]
    if e.adrs:
        parts += ["", "## Decisions", ""]
        parts += [f"- [{a}](../adr/{ADR_FILE[a]}) — {ADR_TITLE[a]}" for a in e.adrs]
    parts += ["", "## Tasks", ""]
    parts.append(
        table(
            ["Task", "Title", "Status"],
            [[f"[{t.id}](../tasks/{t.id}-{t.slug}.md)", t.title, t.status] for t in tasks],
        )
    )
    return "\n".join(parts) + "\n"


def render_sprint(s: Sprint, tasks: list[Task]) -> str:
    parts = [f"# {s.id} — {s.title}", "", f"**Status:** {s.status}", "", "## Theme", "", s.theme]
    parts += ["", "## Tasks", ""]
    parts.append(
        table(
            ["Task", "Epic", "Title", "Status"],
            [
                [
                    f"[{t.id}](../tasks/{t.id}-{t.slug}.md)",
                    f"[{t.epic}](../epics/{EPIC_FILE[t.epic]})",
                    t.title,
                    t.status,
                ]
                for t in tasks
            ],
        )
    )
    return "\n".join(parts) + "\n"


def render_adr(a: ADR) -> str:
    d = 3
    parts = [f"# {a.id} — {a.title}", "", f"**Status:** {a.status}", "", "## Context", "", a.context]
    parts += ["", "## Decision", "", a.decision, "", "## Consequences", ""]
    parts += [f"- {c}" for c in a.consequences]
    parts += ["", "## Alternatives considered", ""]
    parts.append(table(["Option", "Why rejected"], [[o, w] for o, w in a.alternatives]))
    if a.evidence:
        parts += ["", "## Evidence", ""]
        rows = []
        for c, s in a.evidence:
            path = s.split(":")[0]
            linkable = "/" in s and os.path.exists(os.path.join(ROOT, path))
            rows.append([c, f"[`{s}`]({rel(d, path)})" if linkable else f"`{s}`"])
        parts.append(table(["Claim", "Source"], rows))
    return "\n".join(parts) + "\n"


# ── ADRs ──────────────────────────────────────────────────────────────────────

ADRS = [
    ADR(
        id="ADR-001",
        slug="rpc-subprocess-workers",
        title="Peers run as RPC subprocesses, not in-process sessions",
        status="Accepted",
        context=(
            "A peer must survive a crash without taking the daemon with it, carry its own "
            "`cwd`, `HOME`, and environment, and be restartable with backoff. An in-process "
            "`createAgentSession` shares the daemon's process state, so one peer's fault or "
            "env mutation is everyone's."
        ),
        decision=(
            "Every peer is a `bun <omp-cli>` child driven over OMP's `RpcClient`. In-process "
            "sessions are reserved for tests and daemon-internal tooling."
        ),
        consequences=[
            "Crash isolation and per-peer environment come for free.",
            "One child process per running peer; parked peers hold only layout and fingerprint.",
            "`RpcClient.prompt()` returns immediately, so delivery must use `promptAndWait`.",
            "`RpcClient` keeps its child private, so `sessionId` is the observable identity, not a pid.",
        ],
        alternatives=[
            ("In-process sessions for all peers", "One faulting peer takes down the daemon and every sibling."),
            ("Container per peer", "Per-OS runtime dependency far beyond an OMP plugin's install story."),
        ],
        evidence=[
            ("RPC events are `tool_execution_start` / `tool_execution_end`", "node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-client.ts:106-117"),
            ("Worker lifecycle built on RpcClient", "src/worker/lifecycle.ts"),
        ],
    ),
    ADR(
        id="ADR-002",
        slug="private-store-materialized-roots",
        title="Peer definitions live in a private store and are materialized per worker",
        status="Accepted",
        context=(
            "`~/.omp/agent/agents/` is a global OMP discovery root: anything parked there "
            "appears in the `/agents` hub of every unrelated OMP session. Worse, "
            "`discoverAgents()` consults generic native config roots as well as "
            "`getAgentDir()`, so `PI_CODING_AGENT_DIR` alone does not fully reroot discovery."
        ),
        decision=(
            "Definitions live in plugin-private paths. At spawn the daemon materializes a "
            "synthetic user root per worker under `workers/<agent>/home/`, owning `HOME` and "
            "all four `XDG_*` variables, whose `agents/` contains only that worker's own "
            "definition plus its `spawns:` closure."
        ),
        consequences=[
            "A peer definition never leaks into unrelated OMP sessions.",
            "A worker can only discover the agents its `spawns:` closure names.",
            "Writes go to a staged tree and swap by move-aside/restore, never `rm` before `rename`.",
            "Definitions are fingerprinted; a changed definition rebuilds the dir rather than mutating under a live process.",
        ],
        alternatives=[
            ("Write into the global agent root", "Pollutes every unrelated OMP session's agent hub."),
            ("Set PI_CODING_AGENT_DIR only", "Generic native config roots are still consulted, so discovery is not fully rerooted."),
        ],
        evidence=[
            ("Materialization engine", "src/daemon/materializer.ts"),
            ("Discovery precedence pinned against real OMP", "tests/contracts/discovery.contract.test.ts"),
        ],
    ),
    ADR(
        id="ADR-003",
        slug="scoped-credential-gateway",
        title="Workers reach credentials only through a scoped per-worker gateway",
        status="Accepted",
        context=(
            "The auth broker's admin token is vault-wide. Handing it to a worker gives that "
            "worker every credential the user owns, including co-tenants' accounts, and makes "
            "revocation all-or-nothing."
        ),
        decision=(
            "The daemon holds the upstream token alone and fronts it with a loopback gateway. "
            "Each worker gets its own revocable bearer token bound to specific credential ids. "
            "The gateway filters snapshot, stream, refresh, block, and usage routes, and "
            "rewrites upstream generations into a monotonic per-worker view."
        ),
        consequences=[
            "A leaked worker token exposes one account and is revocable on its own.",
            "Foreign-id access returns 403; credential upload and client usage stay admin-only.",
            "A shared-account disable cannot be unilateral: it returns `409 pending_policy` and queues a request.",
            "Aggregate usage is account-filtered by affirmative identity match, so an API-key binding matches nothing rather than falling back to provider.",
        ],
        alternatives=[
            ("Give workers the admin token", "One compromised peer owns the whole vault, and revocation is all-or-nothing."),
            ("Per-worker broker instance", "Duplicates vault state and multiplies refresh races on the same upstream account."),
        ],
        evidence=[
            ("Gateway implementation", "src/daemon/credential-gateway.ts"),
            ("Broker wire protocol pinned against startAuthBroker", "tests/contracts/broker.contract.test.ts"),
            ("Identity match semantics mirror upstream", "node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts:1423-1436"),
        ],
    ),
    ADR(
        id="ADR-004",
        slug="provider-override-not-custom-model",
        title="Worker config emits a provider override, never a custom model entry",
        status="Accepted",
        context=(
            "Routing a worker's turns through the gateway looked like a job for a `models:` "
            "block. It is not: `finalizeCustomModel` builds config models with no `transport` "
            "field, so a custom model cannot carry `pi-native` transport."
        ),
        decision=(
            "Generated worker config emits a provider override only. The worker keeps "
            "selecting its real `provider/id`, and the override points that provider at the "
            "loopback gateway."
        ),
        consequences=[
            "Worker turns actually traverse the gateway instead of dialing the provider directly.",
            "`apiKey` resolves from the environment, so no token is written to disk.",
            "A future OMP change to custom-model transport handling would need this revisited.",
        ],
        alternatives=[
            ("Custom `models:` entry pointing at the gateway", "Config models carry no transport, so turns bypass the gateway and hit the real provider."),
        ],
        evidence=[
            ("Config models are built without a transport field", "node_modules/@oh-my-pi/pi-coding-agent/src/config/custom-models.ts:124-148"),
            ("Env is consulted before literal fallback", "node_modules/@oh-my-pi/pi-coding-agent/src/config/model-config-values.ts:70-74"),
        ],
    ),
    ADR(
        id="ADR-005",
        slug="sandbox-opt-in-fail-closed",
        title="OS sandboxing is opt-in, and opting in fails closed",
        status="Accepted",
        context=(
            "`workspace:` scopes defaults, not access: it does not stop a worker reading "
            "`~/.ssh`. Only an OS sandbox is a real filesystem boundary, but it constrains "
            "tooling and needs per-OS setup, so defaulting it on breaks ordinary use."
        ),
        decision=(
            "Layers 2 and 3 are on by default; the OS sandbox is opt-in per peer. Once a peer "
            "opts in, `startWorker` gates it: probe the adapter and the gateway bridge, and "
            "refuse to launch if either is unavailable. No caller may supply a prebuilt plan."
        ),
        consequences=[
            "An opted-in agent never silently downgrades to an unsandboxed launch.",
            "Linux `bwrap --share-net` cannot enforce port-level loopback, so it requires explicit `unrestricted-host-network` acceptance.",
            "`/agents` shows a shield only for sandboxed agents, so the real guarantee is visible.",
            "The gateway endpoint is validated at materialization: implicit ports and non-loopback hosts are rejected rather than compiling a profile the worker cannot dial.",
        ],
        alternatives=[
            ("Sandbox on by default", "Contradicts the architecture's layer-1 opt-in and breaks tooling on machines with no adapter."),
            ("Warn and continue when the adapter is missing", "An agent the user believes is sandboxed would run unconfined."),
        ],
        evidence=[
            ("Layer 1 is opt-in", "ARCHITECTURE.md:141"),
            ("Launch gate probes then compiles", "src/worker/launch-gate.ts"),
            ("Policy is built once and shared with tests", "src/worker/lifecycle.ts"),
        ],
    ),
    ADR(
        id="ADR-006",
        slug="account-level-quota-parking",
        title="Quota is an account property; subscription accounts auto-resume unattended",
        status="Accepted",
        context=(
            "Billing attaches to the account, not the agent. Several peers can share one "
            "account, so exhausting quota must park every run on that account, not just the "
            "peer that noticed. Requiring a human to unpark defeats the promise of unattended "
            "progress."
        ),
        decision=(
            "The daemon keeps an account registry. Metered accounts warn at 80% of "
            "`budget_usd` and park at 100% pending a human bump. Subscription accounts have no "
            "dollar cap: on a quota block every run parks and a one-shot timer arms from the "
            "verified `blockedUntilMs`, resuming with no human in the loop."
        ),
        consequences=[
            "Resume must deliver, not merely restart: a restarted worker with a full backlog would otherwise idle.",
            "Re-arming uses the latest active deadline across blocks, not the incoming block's, so an earlier block cannot shorten a later one.",
            "The resume deadline is a verified upstream value, not a guess.",
        ],
        alternatives=[
            ("Per-agent budgets", "Peers sharing an account would each think they had a full budget."),
            ("Park until a human resumes", "Defeats the product's central promise of unattended progress."),
        ],
        evidence=[
            ("Account registry and resume arming", "src/daemon/account-registry.ts"),
            ("Quota state machine", "src/daemon/quota-state.ts"),
            ("Upstream produces the block deadline", "ARCHITECTURE.md:172"),
        ],
    ),
    ADR(
        id="ADR-007",
        slug="native-task-delegation",
        title="Peers delegate coding subtasks through native task, never agent_spawn",
        status="Accepted",
        context=(
            "A top-level peer coordinates, and in OMP coordination is the native `task` tool. "
            "An explicit `tools:` list replaces the default set, so writing one naively strips "
            "`task` and leaves the agent unable to delegate at all."
        ),
        decision=(
            "`agent_spawn` creates durable peers only. Coding subtasks go through native "
            "`task`. Any explicit `tools:` list must re-include `task`, and the invariant is "
            "asserted against a real child process, not a mock."
        ),
        consequences=[
            "Subagent isolation and merge-back come from OMP instead of a parallel implementation.",
            "`classifyAgentSpawn` distinguishes a durable peer from a coding subtask at the call boundary.",
            "The end-to-end suite asserts a real child dispatched `task` and never `agent_spawn`.",
        ],
        alternatives=[
            ("Custom subagent spawner", "Reimplements OMP isolation and merge-back, and diverges on every upstream change."),
        ],
        evidence=[
            ("Delegation contract", "ARCHITECTURE.md:101-108"),
            ("Spawn classification", "src/worker/lifecycle.ts"),
            ("Enforcement pinned against OMP", "tests/contracts/spawn-policy.contract.test.ts"),
        ],
    ),
    ADR(
        id="ADR-008",
        slug="tests-share-production-builders",
        title="Tests exercise production construction, never a parallel copy",
        status="Accepted",
        context=(
            "The seatbelt suite originally rebuilt the sandbox policy inline. Production "
            "`gatePeer` could then drift, with wrong `runtimePaths` or dropped `extraRoots`, "
            "while every test stayed green."
        ),
        decision=(
            "Where a test asserts on a construction production also performs, both call one "
            "exported builder. Every regression test is additionally proven non-vacuous: "
            "revert the fix, confirm the test fails, restore."
        ),
        consequences=[
            "A single-field policy drift now fails eight seatbelt tests instead of none.",
            "Non-vacuity probes caught two hollow tests: a delivery assertion that observed only absence, and a room-scoping test with no seeded backlog.",
            "Proving non-vacuity costs an extra run per regression and is required regardless.",
        ],
        alternatives=[
            ("Assert on a hand-built expected policy", "The copy and production drift apart silently, which is the failure this prevents."),
        ],
        evidence=[
            ("Shared policy builder", "src/worker/lifecycle.ts"),
            ("Seatbelt suite consumes it", "tests/seatbelt-wiring.test.ts"),
            ("Engineering practice", "ARCHITECTURE.md:174-178"),
        ],
    ),
]

ADR_FILE = {a.id: f"{a.id}-{a.slug}.md" for a in ADRS}
ADR_TITLE = {a.id: a.title for a in ADRS}


# ── Epics ─────────────────────────────────────────────────────────────────────

EPICS = [
    Epic(
        id="EP-00",
        slug="foundations-and-contracts",
        title="Foundations and OMP contracts",
        status="Done",
        outcome=(
            "The plugin package exists, and the three assumptions everything else rests on "
            "are pinned by tests that run against the real OMP build rather than a mock."
        ),
        why=(
            "Every later epic depends on how OMP actually behaves: where it discovers agents, "
            "what the broker wire protocol is, and how spawn policy is enforced. A wrong guess "
            "here is not a local bug, it is a rewrite. Contract suites turn each assumption "
            "into a failing test the moment an OMP upgrade changes it."
        ),
        scope=[
            "Package manifest exposing the extension through `omp.extensions`.",
            "Test harness with a fake broker and disposable agent directories.",
            "Contract suites for discovery precedence, broker protocol, and spawn policy.",
        ],
        non_goals=[
            "Any daemon behavior; contracts only describe OMP.",
        ],
        acceptance=[
            "`bun test` runs the contract suites against the installed OMP packages.",
            "Discovery precedence is asserted, including that the plugin's private store is not a discovery root.",
            "Broker snapshot, long-poll, block, and refresh shapes are pinned against `startAuthBroker`.",
            "`task.disabledAgents` preflight and `spawns:` enforcement are pinned.",
        ],
        adrs=["ADR-002", "ADR-007"],
    ),
    Epic(
        id="EP-01",
        slug="agent-definitions",
        title="Peer definitions and private store",
        status="Done",
        outcome=(
            "A peer is described by one markdown file with YAML frontmatter, parsed into a "
            "typed definition with a stable fingerprint."
        ),
        why=(
            "The definition is the single seam between what a user writes and everything the "
            "daemon does: discovery, materialization, sandbox policy, scheduling, and rooms "
            "all read it. Parsing it in one place with strict unknown-key rejection stops a "
            "silent typo from becoming a silently unenforced policy."
        ),
        scope=[
            "OMP task-agent frontmatter plus the plugin's own extras.",
            "Strict validation: unknown top-level and nested keys are rejected.",
            "Content fingerprint driving staleness detection.",
        ],
        non_goals=[
            "Loading definitions from disk, which belongs to the daemon store task.",
        ],
        acceptance=[
            "Native OMP keys and plugin extras both parse into `PeerDefinition`.",
            "An unknown key at any level raises `PeerParsingError` with a code.",
            "The fingerprint changes when any effective field changes.",
        ],
        adrs=["ADR-002"],
    ),
    Epic(
        id="EP-02",
        slug="worker-isolation",
        title="Worker isolation: materialization, sandbox, launch gate",
        status="Done",
        outcome=(
            "A worker starts in a synthetic user root it cannot escape by accident, and an "
            "opted-in worker starts under a real OS sandbox or does not start at all."
        ),
        why=(
            "This is the epic where an intuitive mental model is wrong and expensive. "
            "`workspace:` scopes defaults, not access. Isolation only exists where something "
            "enforces it, so the enforcement lives in one place, is compiled from one typed "
            "policy, and fails closed."
        ),
        scope=[
            "Synthetic per-worker root owning `HOME` and the four `XDG_*` variables.",
            "Staged-tree write with move-aside and restore on failure.",
            "Typed sandbox policy compiling to macOS Seatbelt and Linux `bwrap`.",
            "Launch gate that probes the adapter and gateway bridge before compiling.",
        ],
        non_goals=[
            "Claiming the default configuration is a security boundary.",
        ],
        acceptance=[
            "A worker's `agents/` holds only its own definition and its `spawns:` closure.",
            "A failed swap restores the previous worker directory intact.",
            "An opted-in peer with no adapter fails to launch rather than running unconfined.",
            "The seatbelt profile under test is built by the same function production uses.",
        ],
        adrs=["ADR-002", "ADR-005", "ADR-008"],
    ),
    Epic(
        id="EP-03",
        slug="credential-gateway",
        title="Scoped credential gateway",
        status="In progress",
        outcome=(
            "Workers reach model credentials only through a loopback gateway that shows each "
            "one exactly the accounts it is bound to."
        ),
        why=(
            "The upstream admin token is vault-wide. Without a gateway, every peer holds every "
            "credential the user owns, co-tenant accounts included, and revocation is "
            "all-or-nothing. This epic is the difference between multi-agent and multi-tenant."
        ),
        scope=[
            "Per-worker revocable bearer tokens bound to credential ids.",
            "Filtered snapshot, stream, refresh, block, and usage routes.",
            "Monotonic worker-view generations independent of upstream numbering.",
            "Shared-account disable returning `409 pending_policy` with requester recovery.",
        ],
        non_goals=[
            "Replacing OMP's broker; the daemon reuses `startAuthBroker`.",
        ],
        acceptance=[
            "Two workers on the same gateway see disjoint credential sets.",
            "A foreign credential id returns 403 on every scoped route.",
            "Usage data is filtered by affirmative identity match, never by provider fallback.",
            "A shared disable leaves upstream unchanged and peers usable.",
            "A real `RemoteAuthCredentialStore` works against the gateway and recovers from a refused shared disable (T-303).",
        ],
        adrs=["ADR-003", "ADR-004"],
    ),
    Epic(
        id="EP-04",
        slug="autonomy-runtime",
        title="Autonomy runtime: workers, rooms, scheduler, quota",
        status="Done",
        outcome=(
            "Peers run as supervised subprocesses, wake on room traffic, fire on cron, park on "
            "quota exhaustion, and resume unattended."
        ),
        why=(
            "This epic is the product promise. Each part is individually simple and the value "
            "is entirely in the wiring: a resume that restarts without delivering, or a wake "
            "that ignores subscriptions, looks correct in isolation and fails the user."
        ),
        scope=[
            "RPC worker lifecycle with park, resume, and the delegation invariant.",
            "Durable room store with per-agent read cursors.",
            "Cron and one-shot scheduling with Vixie day semantics.",
            "Account registry, quota park, and armed auto-resume.",
            "Supervisor tying delivery, parking, and resume together.",
        ],
        non_goals=[
            "The TUI surface, which is EP-05.",
        ],
        acceptance=[
            "A room post wakes only subscribed, unparked peers.",
            "A quota block parks every run on the account.",
            "The armed timer alone restarts the worker and runs a real turn against the backlog.",
            "A worker delegates through native `task`, proven against a real child.",
        ],
        adrs=["ADR-001", "ADR-006", "ADR-007"],
    ),
    Epic(
        id="EP-05",
        slug="operator-surface",
        title="Operator surface: daemon entry point and TUI",
        status="Ready",
        outcome=(
            "A user can start the daemon, see what their agents are doing, and steer them from "
            "inside the OMP TUI."
        ),
        why=(
            "Every runtime subsystem is built and tested, but nothing a user can launch or look "
            "at exists yet: the extension entry point is still an empty factory and there is no "
            "daemon binary. Until this epic lands the system is complete and unusable."
        ),
        scope=[
            "A `daemon` entry point that boots the broker, gateway, store, and supervisor.",
            "Peer store loading definitions from the private user and project paths.",
            "Toolbelt extension exposing chat and agent tools to workers.",
            "TUI commands, a status widget, and ask-dialogs.",
        ],
        non_goals=[
            "Changing any runtime invariant already covered by EP-02 through EP-04.",
        ],
        acceptance=[
            "`omp-agent daemon` starts, serves a socket, and survives its launching terminal closing.",
            "`/agents` lists peers with state, and shows a shield only for sandboxed ones.",
            "`/rooms` reads and posts as `@you`.",
            "A worker can call `chat_send` and `chat_wait` against the daemon's bus.",
        ],
        adrs=["ADR-001", "ADR-005"],
    ),
]

EPIC_FILE = {e.id: f"{e.id}-{e.slug}.md" for e in EPICS}
EPIC_TITLE = {e.id: e.title for e in EPICS}

# ── Sprints ───────────────────────────────────────────────────────────────────

SPRINTS = [
    Sprint(id="SP-01", slug="contracts-and-parsing", title="Contracts and parsing", status="Done",
           theme="Pin how OMP actually behaves, and turn a peer file into a typed definition."),
    Sprint(id="SP-02", slug="isolation", title="Isolation", status="Done",
           theme="Materialized roots, compiled sandbox policies, and a launch gate that fails closed."),
    Sprint(id="SP-03", slug="credentials", title="Credentials", status="Done",
           theme="A scoped gateway so a worker sees one account, not the vault."),
    Sprint(id="SP-04", slug="autonomy", title="Autonomy", status="Done",
           theme="Workers, rooms, schedules, quota parking, and unattended resume."),
    Sprint(id="SP-05", slug="operator-surface", title="Operator surface", status="Ready",
           theme="The parts a human touches: daemon entry point, toolbelt, and TUI."),
]

SPRINT_FILE = {s.id: f"{s.id}-{s.slug}.md" for s in SPRINTS}


# ── Tasks ─────────────────────────────────────────────────────────────────────

ARCH = ("ARCHITECTURE.md", "ARCHITECTURE.md")

TASKS = [
    # ── EP-00 ────────────────────────────────────────────────────────────────
    Task(
        id="T-001", slug="package-scaffold", title="Plugin package scaffold",
        epic="EP-00", sprint="SP-01", status="Done",
        goal="OMP recognises the repository as an installable plugin exposing one extension.",
        read_first=[ARCH, ("Repo layout", "ARCHITECTURE.md")],
        files=["package.json", "tsconfig.json", "src/extension/index.ts"],
        assets=[
            ("package.json", "New", "Declares `omp.extensions`."),
            ("src/extension/index.ts", "New", "Extension factory; body lands in T-501."),
        ],
        steps=[
            "Create the package manifest with `omp.name`, `omp.version`, and the extension path.",
            "Pin OMP packages as peer plus dev dependencies so tests resolve the real build.",
            "Add `typecheck` and `test` scripts.",
        ],
        acceptance=[
            "`bun test` and `tsc --noEmit` both run clean on an empty tree.",
            "The manifest names `src/extension/index.ts` under `omp.extensions`.",
        ],
        evidence=[("Scaffold suite, 4 tests", "tests/scaffold.test.ts"), ("Commit", "c7b90bd")],
        unblocks=["T-002"],
    ),
    Task(
        id="T-002", slug="test-harness", title="Contract-test harness",
        epic="EP-00", sprint="SP-01", status="Done",
        goal="Suites can stand up a broker and a disposable agent directory without touching the user's real profile.",
        read_first=[ARCH],
        files=["tests/fixtures/fake-broker.ts", "tests/fixtures/temp-agent-dir.ts", "tests/harness.test.ts"],
        assets=[
            ("tests/fixtures/fake-broker.ts", "New", "Loopback broker stand-in."),
            ("tests/fixtures/temp-agent-dir.ts", "New", "Disposable `PI_CODING_AGENT_DIR`."),
        ],
        steps=[
            "Write a fake broker binding `127.0.0.1:0`, since `startAuthBroker` otherwise defaults to port 8765.",
            "Write a temp agent dir helper that cleans up on dispose.",
            "Cover both fixtures with their own tests so a broken fixture fails loudly rather than silently weakening every suite.",
        ],
        acceptance=[
            "The fake broker binds an ephemeral loopback port.",
            "The temp agent dir is removed after use.",
            "8 harness tests pass.",
        ],
        evidence=[("Harness suite, 8 tests", "tests/harness.test.ts"), ("Commit", "ff663c5")],
        depends_on=["T-001"], unblocks=["T-003", "T-004", "T-005"],
    ),
    Task(
        id="T-003", slug="discovery-contract", title="Agent discovery precedence contract",
        epic="EP-00", sprint="SP-01", status="Done",
        goal="OMP's real discovery order is pinned, including that the plugin's private store is invisible to it.",
        read_first=[ARCH],
        files=["tests/contracts/discovery.contract.test.ts"],
        assets=[
            ("tests/contracts/discovery.contract.test.ts", "New", "Runs against installed OMP."),
            ("src/daemon/materializer.ts", "Read only, not edited by this task", "Consumes this contract."),
        ],
        steps=[
            "Assert project, user, and native config root precedence against `discoverAgents()`.",
            "Assert the plugin's `.omp/<plugin>/agents` path is not a discovery root, which is the whole reason for materialization.",
            "Assert `PI_CODING_AGENT_DIR` reroots `getAgentDir()` but does not suppress generic native roots.",
        ],
        acceptance=[
            "9 tests pass against the installed OMP packages.",
            "A future OMP change to discovery order fails this suite rather than silently leaking definitions.",
        ],
        evidence=[("Discovery contract, 9 tests", "tests/contracts/discovery.contract.test.ts"), ("Commit", "eda0c5b")],
        depends_on=["T-002"], unblocks=["T-201"],
    ),
    Task(
        id="T-004", slug="broker-contract", title="Auth broker wire-protocol contract",
        epic="EP-00", sprint="SP-01", status="Done",
        goal="The broker's snapshot, long-poll, block, and refresh shapes are pinned against the real server.",
        read_first=[ARCH],
        files=["tests/contracts/broker.contract.test.ts"],
        assets=[
            ("tests/contracts/broker.contract.test.ts", "New", "Exercises `startAuthBroker`."),
            ("src/daemon/credential-gateway.ts", "Read only, not edited by this task", "Proxies this protocol."),
        ],
        steps=[
            "Start a real broker on an ephemeral loopback port.",
            "Assert snapshot shape, ETag semantics, conditional long-poll, block, and refresh.",
            "Seed credentials through `store.upsertAuthCredentialForProvider` then `storage.reload()`, since `AuthStorage` exposes no direct add.",
        ],
        acceptance=[
            "8 tests pass against `startAuthBroker`.",
            "Generation and ETag semantics are asserted, not assumed.",
        ],
        evidence=[("Broker contract, 8 tests", "tests/contracts/broker.contract.test.ts"), ("Commit", "f9ae30e")],
        depends_on=["T-002"], unblocks=["T-301"],
    ),
    Task(
        id="T-005", slug="spawn-policy-contract", title="Spawn policy enforcement contract",
        epic="EP-00", sprint="SP-01", status="Done",
        goal="`spawns:` enforcement and the `task.disabledAgents` preflight are pinned against OMP.",
        read_first=[ARCH],
        files=["tests/contracts/spawn-policy.contract.test.ts"],
        assets=[
            ("tests/contracts/spawn-policy.contract.test.ts", "New", "Pins enforcement."),
            ("src/worker/lifecycle.ts", "Read only, not edited by this task", "Implements the classification."),
        ],
        steps=[
            "Assert an explicit `tools:` list replaces rather than extends the default set, which is how `task` gets silently stripped.",
            "Assert the disabled-agents snapshot is enumerated at spawn.",
            "Cover the peer versus coding-subtask distinction.",
        ],
        acceptance=[
            "23 tests pass.",
            "Stripping `task` from a `tools:` list is detectable by test, not by production surprise.",
        ],
        evidence=[("Spawn policy contract, 23 tests", "tests/contracts/spawn-policy.contract.test.ts"), ("Commit", "4cba1ad")],
        depends_on=["T-002"], unblocks=["T-401"],
    ),
    # ── EP-01 ────────────────────────────────────────────────────────────────
    Task(
        id="T-101", slug="peer-definition-parser", title="Peer definition parser",
        epic="EP-01", sprint="SP-01", status="Done",
        goal="A markdown file with YAML frontmatter becomes a validated `PeerDefinition` with a stable fingerprint.",
        read_first=[ARCH, ("Discovery contract", "tests/contracts/discovery.contract.test.ts")],
        files=["src/shared/agent-definition.ts"],
        assets=[
            ("src/shared/agent-definition.ts", "New", "Parser, types, fingerprint."),
            ("tests/agent-definition.test.ts", "New", "59 tests."),
        ],
        steps=[
            "Accept OMP's native task-agent keys unchanged so definitions stay portable.",
            "Add plugin extras: `workspace`, `rooms`, `wake`, `autonomy`, `sandbox`, `mcps`, `skills`, `schedules`, `automations`.",
            "Reject unknown keys at top level and inside nested objects, because a silently ignored typo in `sandbox:` is an unenforced policy.",
            "Fingerprint the effective definition for staleness detection.",
        ],
        acceptance=[
            "Native and extra keys parse into `PeerDefinition`.",
            "An unknown key raises `PeerParsingError` carrying a code.",
            "`spawns:` accepts a list or `*`.",
            "The fingerprint changes when any effective field changes.",
            "59 tests pass.",
        ],
        evidence=[("Parser suite, 59 tests", "tests/agent-definition.test.ts"), ("Commit", "d34fafa")],
        depends_on=["T-003"], unblocks=["T-201", "T-501"],
    ),
    # ── EP-02 ────────────────────────────────────────────────────────────────
    Task(
        id="T-201", slug="materialization-engine", title="Synthetic worker root materialization",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="Each worker gets a private user root containing only the definitions it is allowed to see.",
        read_first=[ARCH, ("Discovery contract", "tests/contracts/discovery.contract.test.ts")],
        files=["src/daemon/materializer.ts"],
        assets=[
            ("src/daemon/materializer.ts", "New", "Staged write and atomic swap."),
            ("src/shared/agent-definition.ts", "Read", "Supplies the parsed definition and fingerprint."),
            ("tests/materializer.test.ts", "New", "30 tests."),
        ],
        steps=[
            "Build the root under `workers/<agent>/home/`, owning `HOME` and all four `XDG_*` variables, because rerooting `PI_CODING_AGENT_DIR` alone leaves generic native roots in play.",
            "Write the worker's own definition plus its `spawns:` closure, and nothing else.",
            "Emit generated config with a provider override, never a `models:` entry, since config models carry no transport and would bypass the gateway.",
            "Validate the gateway endpoint here: reject implicit ports and non-loopback hosts at the boundary rather than compiling a profile the worker cannot dial.",
            "Write to a staged tree, then swap by moving the old root aside and restoring it if the swap fails. Never `rm` before `rename`.",
        ],
        acceptance=[
            "The materialized `agents/` holds only the worker's definition and its closure.",
            "A `spawns:` entry with no source definition is rejected.",
            "A name that would escape the agent dir is rejected.",
            "A failed swap leaves the previous root intact.",
            "The endpoint validator rejects an implicit port and a non-loopback host.",
            "30 tests pass.",
        ],
        evidence=[("Materializer suite, 30 tests", "tests/materializer.test.ts"), ("Commits", "c0fdf23, 476bda3")],
        depends_on=["T-003", "T-101"], unblocks=["T-401"],
    ),
    Task(
        id="T-202", slug="sandbox-policy-compiler", title="Typed sandbox policy compiler",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="One typed policy compiles to a macOS Seatbelt profile or Linux `bwrap` argv.",
        read_first=[ARCH],
        files=["src/worker/sandbox.ts"],
        assets=[
            ("src/worker/sandbox.ts", "New", "Policy type and both compilers."),
            ("tests/sandbox.test.ts", "New", "51 tests."),
        ],
        steps=[
            "Define the policy: workspace, worker home, runtime paths, gateway endpoint, loopback ports, extra roots.",
            "Compile Darwin to `-p <profile>` with no `--` separator, and Linux to `bwrap` argv which does take one.",
            "Fail closed on Linux unless the peer accepts `unrestricted-host-network`, because `--share-net` cannot enforce port-level loopback.",
        ],
        acceptance=[
            "Darwin profiles allow the declared roots and the loopback gateway port.",
            "Linux argv is rejected without explicit network acceptance.",
            "An unsupported platform fails closed.",
            "51 tests pass.",
        ],
        evidence=[("Sandbox suite, 51 tests", "tests/sandbox.test.ts"), ("Commit", "84ff8d9")],
        unblocks=["T-203"],
    ),
    Task(
        id="T-203", slug="sandbox-launch-gate", title="Sandbox launch gate",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="An opted-in peer launches sandboxed or does not launch.",
        read_first=[ARCH, ("Sandbox compiler", "src/worker/sandbox.ts")],
        files=["src/worker/launch-gate.ts"],
        assets=[
            ("src/worker/launch-gate.ts", "New", "Probe, then compile."),
            ("src/worker/sandbox.ts", "Read", "Supplies the compiler."),
            ("tests/sandbox-gate.test.ts", "New", "13 tests."),
        ],
        steps=[
            "Probe the adapter binary and the gateway bridge before compiling anything.",
            "Fail closed when either probe fails, rather than downgrading to an unconfined launch the user believes is sandboxed.",
            "Return only the compiled command and argv.",
        ],
        acceptance=[
            "A missing adapter fails the launch.",
            "An unreachable gateway bridge fails the launch.",
            "A successful probe yields compiled argv.",
            "13 tests pass.",
        ],
        evidence=[("Launch gate suite, 13 tests", "tests/sandbox-gate.test.ts"), ("Commit", "19c2349")],
        depends_on=["T-202"], unblocks=["T-401"],
    ),
    Task(
        id="T-204", slug="shared-policy-builder", title="Share the worker policy builder with tests",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="The seatbelt suite asserts on the policy production actually builds.",
        read_first=[ARCH],
        files=["src/worker/lifecycle.ts", "tests/seatbelt-wiring.test.ts"],
        assets=[
            ("src/worker/lifecycle.ts", "Edited", "Exports `buildWorkerPolicy`."),
            ("tests/seatbelt-wiring.test.ts", "Edited", "Consumes it instead of a copy."),
        ],
        steps=[
            "Extract `buildWorkerPolicy(peer, layout, cwd)` from `gatePeer`.",
            "Point the seatbelt suite at it, so a drift in production construction fails the tests instead of hiding behind a duplicate.",
            "Prove the coupling: change one policy field and confirm the suite fails.",
        ],
        acceptance=[
            "`gatePeer` and the seatbelt suite call the same builder.",
            "Changing `workerHome` to `cwd` fails 8 of 10 seatbelt tests.",
            "10 tests pass with the builder intact.",
        ],
        evidence=[("Seatbelt suite, 10 tests", "tests/seatbelt-wiring.test.ts"), ("Commit", "43de7fb")],
        depends_on=["T-203"],
    ),
]

TASKS += [
    # ── EP-03 ────────────────────────────────────────────────────────────────
    Task(
        id="T-301", slug="credential-gateway", title="Scoped per-worker credential gateway",
        epic="EP-03", sprint="SP-03", status="Done",
        goal="Each worker sees only the credentials its token is bound to, through a loopback proxy.",
        read_first=[ARCH, ("Broker contract", "tests/contracts/broker.contract.test.ts")],
        files=["src/daemon/credential-gateway.ts"],
        assets=[
            ("src/daemon/credential-gateway.ts", "New", "Token issuance, filtering, generations."),
            ("tests/credential-gateway.test.ts", "New", "44 tests."),
        ],
        steps=[
            "Issue a revocable bearer token per worker, bound to explicit credential ids.",
            "Filter snapshot, stream, refresh, block, and usage by those bindings; foreign ids return 403.",
            "Rewrite upstream generations into a monotonic worker view, so upstream renumbering cannot make a worker's view go backwards.",
            "Keep credential upload and `/v1/usage/clients` admin-only.",
            "Filter usage by affirmative identity match; an API-key binding carries no account identity and must match nothing rather than falling back to provider.",
            "Bind loopback only.",
        ],
        acceptance=[
            "Two workers see disjoint credential sets.",
            "A foreign id returns 403 on refresh and block.",
            "The worker-view generation never decreases.",
            "An API-key binding sees no usage reports.",
            "`close()` completes while a watcher is parked on a long-poll.",
            "44 tests pass.",
        ],
        evidence=[("Gateway suite, 44 tests", "tests/credential-gateway.test.ts"), ("Commits", "0fea451, c5e3e75")],
        depends_on=["T-004"], unblocks=["T-302", "T-401"],
    ),
    Task(
        id="T-302", slug="shared-disable-recovery", title="Shared-account disable and requester recovery",
        epic="EP-03", sprint="SP-03", status="Done",
        goal="One worker cannot unilaterally disable a credential its peers depend on, and recovers cleanly when refused.",
        read_first=[ARCH, ("Gateway", "src/daemon/credential-gateway.ts")],
        files=["src/daemon/credential-gateway.ts", "tests/credential-gateway.test.ts"],
        assets=[
            ("src/daemon/credential-gateway.ts", "Edited", "Pending-policy path."),
            ("tests/credential-gateway.test.ts", "Edited", "Recovery and long-poll cases."),
        ],
        steps=[
            "Return `409 pending_policy` with a request id when the account is shared, and queue `{credentialId, workerId}`.",
            "Leave upstream untouched, so peers keep working.",
            "Bump only the requester's worker-view generation and emit a full snapshot, because `RemoteAuthCredentialStore` optimistically removes the credential locally and only a full snapshot with a not-older generation restores it.",
            "Proxy a dedicated-account disable straight through.",
        ],
        acceptance=[
            "A shared disable returns 409 with a request id and leaves upstream unchanged.",
            "The requester's long-poll wakes with a full snapshot carrying a newer generation.",
            "A peer's long-poll is not woken by another worker's pending disable.",
            "A dedicated-account disable proxies upstream and returns its result.",
        ],
        out_of_scope=[
            "Proving a real `RemoteAuthCredentialStore` restores the credential. These "
            "suites drive the gateway with `fetch`, so the wire response is verified but "
            "the client's reaction to it is inferred from upstream source, not exercised. "
            "T-303 closes that gap.",
        ],
        evidence=[("Recovery and long-poll cases", "tests/credential-gateway.test.ts"), ("Commit", "c5e3e75")],
        depends_on=["T-301"],
    ),
    Task(
        id="T-303", slug="client-integration", title="Drive the gateway with a real credential store",
        epic="EP-03", sprint="SP-05", status="Ready",
        goal="A stock `RemoteAuthCredentialStore` is proven to work against the gateway, including recovering from a refused shared disable.",
        read_first=[ARCH, ("Gateway", "src/daemon/credential-gateway.ts"), ("Gateway suite", "tests/credential-gateway.test.ts")],
        files=["tests/gateway-client.test.ts"],
        assets=[
            ("tests/gateway-client.test.ts", "New", "Integration suite using the real client."),
            ("src/daemon/credential-gateway.ts", "Read", "Subject under test; no change expected."),
            ("node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts", "Read only, not edited by this task", "The client whose behavior is currently inferred rather than exercised."),
        ],
        steps=[
            "Point a real `RemoteAuthCredentialStore` at the gateway with a worker token, rather than issuing raw `fetch` calls as the existing suite does.",
            "Assert it loads exactly the bound credentials and follows the stream through an upstream change.",
            "Request a shared-account disable and assert the store ends holding the credential again, since it removes it optimistically and only a full snapshot with a not-older generation puts it back. This is the step the existing suite cannot perform.",
            "Assert a peer store on the same gateway is unaffected throughout.",
            "If the client turns out to need a behavior the gateway does not provide, fix the gateway; do not weaken the assertion to match.",
        ],
        acceptance=[
            "A real store loads only its bound credentials through the gateway.",
            "After a refused shared disable, the requester's store holds the credential again without a manual reload.",
            "A peer's store is unaffected by the requester's refused disable.",
            "An upstream change reaches the real store through the gateway's stream.",
        ],
        depends_on=["T-302"],
        out_of_scope=["Changing gateway semantics; T-301 and T-302 own those."],
    ),
    # ── EP-04 ────────────────────────────────────────────────────────────────
    Task(
        id="T-401", slug="worker-lifecycle", title="RPC worker lifecycle",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="A peer runs as a supervised child process that parks, resumes, and delegates through native `task`.",
        read_first=[ARCH, ("Spawn policy contract", "tests/contracts/spawn-policy.contract.test.ts")],
        files=["src/worker/lifecycle.ts"],
        assets=[
            ("src/worker/lifecycle.ts", "New", "Start, park, resume, classify."),
            ("src/daemon/materializer.ts", "Read", "Supplies the layout."),
            ("src/worker/launch-gate.ts", "Read", "Gates opted-in peers."),
            ("tests/worker-lifecycle.test.ts", "New", "22 tests."),
        ],
        steps=[
            "Drive the child with OMP's `RpcClient`; deliver turns with `promptAndWait`, since `prompt()` returns immediately.",
            "Pass the definition through `PI_CODING_AGENT_DIR` and its body via `--append-system-prompt`, because no `--agent` CLI flag exists.",
            "Gate sandboxed peers inside `startWorker` itself, so no caller can supply a prebuilt plan and bypass the probe.",
            "Park by stopping the child and keeping layout plus fingerprint; resume materializes fresh when the fingerprint moved.",
            "Expose `sessionId` as identity rather than a pid, which `RpcClient` keeps private.",
            "Classify `agent_spawn` payloads: durable peer versus coding subtask.",
        ],
        acceptance=[
            "A real child dispatches `task` and never `agent_spawn` for a coding subtask.",
            "An opted-in peer with no adapter fails to start.",
            "A parked worker holds no child process.",
            "22 tests pass.",
        ],
        evidence=[("Lifecycle suite, 22 tests", "tests/worker-lifecycle.test.ts"), ("Commits", "e5855e1, 4117458")],
        depends_on=["T-005", "T-201", "T-203", "T-301"], unblocks=["T-405"],
    ),
    Task(
        id="T-402", slug="room-store", title="Durable room store",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="Rooms, messages, and per-agent read cursors survive a daemon restart.",
        read_first=[ARCH],
        files=["src/rooms/store.ts"],
        assets=[
            ("src/rooms/store.ts", "New", "SQLite-backed bus."),
            ("tests/rooms.test.ts", "New", "25 tests."),
        ],
        steps=[
            "Create `rooms`, `messages`, and `subscriptions` tables with a channel-or-dm check constraint.",
            "Track `last_read_id` per agent per room.",
            "Return pending messages per agent; note the `LEFT JOIN` means a subscribed room always yields an entry with an empty list, so callers filter on length rather than expecting no entry.",
        ],
        acceptance=[
            "Messages and cursors persist across store reopen.",
            "`unreadCount` reflects posts since the cursor.",
            "`pendingForAgent` returns an empty message list, not a missing entry, for a quiet subscribed room.",
            "25 tests pass.",
        ],
        evidence=[("Room suite, 25 tests", "tests/rooms.test.ts"), ("Commit", "96e7d9d")],
        unblocks=["T-405"],
    ),
    Task(
        id="T-403", slug="scheduler", title="Cron and one-shot scheduler",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="Schedules fire on Vixie cron semantics, and one-shot timers drive quota resume.",
        read_first=[ARCH],
        files=["src/daemon/scheduler.ts"],
        assets=[
            ("src/daemon/scheduler.ts", "New", "`nextCronTime`, `addOnce`."),
            ("tests/scheduler.test.ts", "New", "47 tests."),
        ],
        steps=[
            "Implement `nextCronTime` with the four explicit Vixie day branches, since restricted DOM and DOW is a union rather than an intersection.",
            "Add version-guarded `addOnce`, where re-arming the same job name replaces the pending deadline.",
            "Fire immediately for a deadline already in the past.",
        ],
        acceptance=[
            "Both-restricted day fields match the union.",
            "Re-arming a job name replaces rather than duplicates its timer.",
            "A past deadline fires immediately.",
            "47 tests pass.",
        ],
        evidence=[("Scheduler suite, 47 tests", "tests/scheduler.test.ts"), ("Commits", "2409cb9, 22b6a97, b88bab5")],
        unblocks=["T-404"],
    ),
    Task(
        id="T-404", slug="account-registry", title="Account registry and quota state machine",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="Quota exhaustion parks every run on the account and arms an unattended resume.",
        read_first=[ARCH, ("Scheduler", "src/daemon/scheduler.ts")],
        files=["src/daemon/quota-state.ts", "src/daemon/account-registry.ts"],
        assets=[
            ("src/daemon/quota-state.ts", "New", "Metered and subscription transitions."),
            ("src/daemon/account-registry.ts", "New", "Registry plus resume arming."),
            ("tests/account-registry.test.ts", "New", "16 tests."),
        ],
        steps=[
            "Warn a metered account at 80% and park at 100% pending a human bump.",
            "Park every run on the account for a subscription block, not just the peer that noticed.",
            "Arm resume from `activeUntilMs()`, the latest active deadline across blocks, so an earlier block cannot shorten a later one.",
            "Key the one-shot by account so re-arming replaces the pending deadline.",
        ],
        acceptance=[
            "A block parks all runs on the account.",
            "Resume arms from the latest active deadline, not the incoming block's.",
            "A metered bump resumes immediately.",
            "16 tests pass.",
        ],
        evidence=[("Registry suite, 16 tests", "tests/account-registry.test.ts"), ("Commit", "2291765")],
        depends_on=["T-403"], unblocks=["T-405"],
    ),
    Task(
        id="T-405", slug="supervisor", title="Supervisor: delivery, parking, resume",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="A room post reaches the right peers, and an armed timer alone restarts a parked worker and runs its backlog.",
        read_first=[ARCH, ("Worker lifecycle", "src/worker/lifecycle.ts"), ("Room store", "src/rooms/store.ts")],
        files=["src/daemon/supervisor.ts"],
        assets=[
            ("src/daemon/supervisor.ts", "New", "Ties runtime pieces together."),
            ("src/daemon/account-registry.ts", "Read", "Park and resume signals."),
            ("tests/supervisor.test.ts", "New", "13 tests."),
            ("tests/end-to-end.test.ts", "New", "6 tests."),
        ],
        steps=[
            "Own `post()` as the production trigger, so delivery is not something only a test can drive.",
            "Filter by tracked subscription and skip parked peers, because `deliver` drains a peer's entire backlog and an unrelated room would otherwise flush it.",
            "Skip the author, so a peer's own post does not wake it.",
            "On resume, call `resume()` then `deliver()`: a restarted worker with a full backlog would otherwise idle, defeating unattended progress.",
            "Expose `settled()` so callers can await queued park and resume work.",
        ],
        acceptance=[
            "A post wakes only subscribed, unparked peers.",
            "A post in an unsubscribed room leaves the peer's backlog untouched.",
            "The armed timer alone restarts the worker and its child dispatches a real tool call.",
            "A parked peer is skipped rather than burning a turn that would fail.",
            "19 tests pass across the supervisor and end-to-end suites.",
        ],
        evidence=[
            ("Supervisor suite, 13 tests", "tests/supervisor.test.ts"),
            ("End-to-end suite, 6 tests", "tests/end-to-end.test.ts"),
            ("Commits", "5bae1e0, ef1cbe0"),
        ],
        depends_on=["T-401", "T-402", "T-404"],
    ),
    # ── EP-05: remaining work ────────────────────────────────────────────────
    Task(
        id="T-501", slug="peer-store", title="Peer store: load definitions from the private paths",
        epic="EP-05", sprint="SP-05", status="Ready",
        goal="The daemon can enumerate peer definitions from the user and project private stores.",
        read_first=[ARCH, ("Parser", "src/shared/agent-definition.ts"), ("Discovery contract", "tests/contracts/discovery.contract.test.ts")],
        files=["src/daemon/peer-store.ts", "tests/peer-store.test.ts"],
        assets=[
            ("src/daemon/peer-store.ts", "New", "Enumerates and parses definitions."),
            ("src/shared/agent-definition.ts", "Read", "`parsePeerDefinition` already exists; do not reimplement parsing."),
            ("src/daemon/materializer.ts", "Read only, not edited by this task", "Consumes the loaded definitions."),
        ],
        steps=[
            "Read `~/.omp/agent/oh-my-agent/agents/*.md` and `<project>/.omp/oh-my-agent/agents/*.md`.",
            "Let a project definition shadow a user definition of the same name, matching OMP's own precedence so users are not surprised.",
            "Parse each through `parsePeerDefinition`; surface a parse failure with its file path rather than skipping the file silently, since a silently skipped peer looks identical to a peer that never existed.",
            "Expose lookup by name plus a full listing for `/agents`.",
        ],
        acceptance=[
            "Definitions load from both stores, with project shadowing user.",
            "Neither path is an OMP discovery root, re-asserted here so a future refactor cannot quietly relocate the store into one.",
            "A malformed definition reports its file path and does not abort the whole listing.",
            "Lookup by name returns the shadowing definition.",
        ],
        depends_on=["T-101"], unblocks=["T-502", "T-504"],
        out_of_scope=["Materialization, which T-201 already owns."],
    ),
    Task(
        id="T-502", slug="daemon-entry-point", title="Daemon entry point",
        epic="EP-05", sprint="SP-05", status="Ready",
        goal="`omp-agent daemon` boots every subsystem and keeps running after its terminal closes.",
        read_first=[ARCH, ("Broker hosting", "src/daemon/boot.ts"), ("Supervisor", "src/daemon/supervisor.ts")],
        files=["src/daemon/main.ts", "src/daemon/socket.ts", "package.json", "tests/daemon-main.test.ts"],
        assets=[
            ("src/daemon/main.ts", "New", "Composition root."),
            ("src/daemon/socket.ts", "New", "Control socket for the TUI."),
            ("src/daemon/boot.ts", "Read", "`resolveBrokerHosting` already exists."),
            ("src/daemon/credential-gateway.ts", "Read", "Started here."),
            ("src/daemon/supervisor.ts", "Read", "Started here."),
            ("package.json", "Edited", "Adds the `bin` entry."),
        ],
        steps=[
            "Compose boot order: resolve broker hosting, start the gateway, open the room store, construct the scheduler, registry, and supervisor.",
            "Register peers from the store and arm their schedules.",
            "Serve a control socket and write a pidfile under the active agent dir, honoring `PI_CODING_AGENT_DIR`.",
            "Detach from the controlling TTY, since surviving a closed terminal is the product's core claim.",
            "Shut down in reverse order so a stop does not strand a parked watcher or leave a half-swapped worker dir.",
        ],
        acceptance=[
            "The daemon starts, serves its socket, and answers a status request.",
            "It keeps running after its launching terminal exits.",
            "A second instance for the same profile refuses to start rather than corrupting shared state.",
            "Shutdown closes the gateway, stops workers, and removes the pidfile.",
            "Boot honors `PI_CODING_AGENT_DIR` for socket and pidfile placement.",
        ],
        depends_on=["T-501"], unblocks=["T-503", "T-504"],
        out_of_scope=["TUI rendering, which is T-504."],
    ),
    Task(
        id="T-503", slug="agent-toolbelt", title="Worker toolbelt extension",
        epic="EP-05", sprint="SP-05", status="Ready",
        goal="A worker can talk to rooms and peers through tools injected into its own session.",
        read_first=[ARCH, ("Room store", "src/rooms/store.ts"), ("Spawn classification", "src/worker/lifecycle.ts")],
        files=["src/worker/toolbelt.ts", "tests/toolbelt.test.ts"],
        assets=[
            ("src/worker/toolbelt.ts", "New", "`chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`."),
            ("src/rooms/store.ts", "Read", "Backing bus."),
            ("src/worker/lifecycle.ts", "Read", "`classifyAgentSpawn` already exists; reuse it."),
            ("src/daemon/socket.ts", "Read", "Transport to the daemon."),
        ],
        steps=[
            "Expose the toolbelt as an OMP extension loaded into each worker session.",
            "Route every call over the daemon control socket, so the worker never touches the room database directly and cannot corrupt a shared writer.",
            "Implement `chat_wait` as a blocking wait the daemon can satisfy on a wake, rather than a poll loop that burns turns.",
            "Route `agent_spawn` through `classifyAgentSpawn` and reject a coding subtask with a message naming `task` as the correct tool.",
            "Keep the tool list additive: never emit an explicit `tools:` list that would strip native `task`.",
        ],
        acceptance=[
            "`chat_send` posts and the message is visible to a subscribed peer.",
            "`chat_wait` blocks and returns when a matching message arrives.",
            "`agent_spawn` with a coding-subtask payload is refused and names `task`.",
            "A worker with the toolbelt still exposes native `task` in its effective tool list.",
        ],
        depends_on=["T-502"],
        out_of_scope=["New room semantics; T-402 owns the store."],
    ),
    Task(
        id="T-504", slug="tui-surface", title="TUI commands, status widget, and dialogs",
        epic="EP-05", sprint="SP-05", status="Ready",
        goal="A human can see and steer running agents from inside the OMP TUI.",
        read_first=[ARCH, ("Extension stub", "src/extension/index.ts"), ("Isolation layers", "ARCHITECTURE.md")],
        files=["src/extension/index.ts", "src/extension/commands.ts", "src/extension/widget.ts", "tests/extension.test.ts"],
        assets=[
            ("src/extension/index.ts", "Edited", "Currently a no-op factory."),
            ("src/extension/commands.ts", "New", "`/agents`, `/rooms`, `/schedule`."),
            ("src/extension/widget.ts", "New", "Status line."),
            ("src/daemon/socket.ts", "Read", "Data source."),
        ],
        steps=[
            "Implement `/agents` listing name, state, account, and room subscriptions.",
            "Show a shield only for peers actually running under an OS sandbox, never for `workspace:` scoping, because a shield on an unsandboxed agent is a false security claim.",
            "Implement `/rooms` to read a transcript and post as `@you`.",
            "Implement `/schedule` to list and arm schedules.",
            "Add a status widget with running and parked counts plus unread totals.",
            "Use ask-dialogs for destructive actions: killing a worker, bumping a metered budget.",
            "Degrade to a clear message when no daemon is running, rather than throwing inside the TUI.",
        ],
        acceptance=[
            "`/agents` lists peers with live state from the daemon.",
            "The shield appears only for sandboxed peers, verified against one sandboxed and one unsandboxed agent.",
            "`/rooms` posts as `@you` and the message wakes a subscribed peer.",
            "Killing a worker asks for confirmation first.",
            "With no daemon running, every command reports that clearly instead of raising.",
        ],
        depends_on=["T-502"],
        out_of_scope=["Bus semantics and worker lifecycle, already covered by EP-04."],
    ),
    Task(
        id="T-505", slug="definition-staleness", title="Rebuild a worker when its definition changes",
        epic="EP-05", sprint="SP-05", status="Ready",
        goal="A parked worker whose definition changed is rebuilt before it is reused.",
        read_first=[ARCH, ("Materializer", "src/daemon/materializer.ts"), ("Lifecycle", "src/worker/lifecycle.ts")],
        files=[
            "src/daemon/supervisor.ts",
            "src/worker/lifecycle.ts",
            "src/daemon/peer-store.ts",
            "tests/supervisor.test.ts",
        ],
        assets=[
            ("src/daemon/supervisor.ts", "Edited", "Fingerprint check and rebuild before wake."),
            ("src/worker/lifecycle.ts", "Edited", "Replace a parked worker's layout after re-materialization."),
            ("src/daemon/peer-store.ts", "Edited", "Re-read the definition so the comparison uses current disk state."),
            ("src/shared/agent-definition.ts", "Read", "`fingerprintPeerDefinition` already exists."),
            ("src/daemon/materializer.ts", "Read", "Performs the rebuild; T-201 owns it."),
        ],
        steps=[
            "Re-read the definition from the peer store before comparing, since a fingerprint recomputed from the in-memory copy can never differ from itself.",
            "Recompute the effective fingerprint before every wake or scheduled run.",
            "On a match reuse the parked worker; on a mismatch stop it, re-materialize, and start a fresh session before delivering.",
            "Give the worker handle a way to adopt the rebuilt layout, because its current layout and fingerprint are fixed at construction.",
            "Deliver only after the rebuild, so a message is never handled by a worker running a superseded policy.",
        ],
        acceptance=[
            "An unchanged definition reuses the parked worker with no re-materialization.",
            "A changed definition rebuilds the worker directory and starts a fresh session.",
            "Messages queued during the rebuild are delivered afterwards, not dropped.",
            "No policy-changing file is mutated under a live process.",
        ],
        depends_on=["T-501", "T-502"],
    ),
    Task(
        id="T-506", slug="metered-budget-wiring", title="Wire metered budget warnings into rooms",
        epic="EP-05", sprint="SP-05", status="Ready",
        goal="A metered account's 80% warning reaches a human where they will see it.",
        read_first=[ARCH, ("Registry", "src/daemon/account-registry.ts"), ("Supervisor", "src/daemon/supervisor.ts")],
        files=["src/daemon/supervisor.ts", "tests/supervisor.test.ts"],
        assets=[
            ("src/daemon/supervisor.ts", "Edited", "`onWarning` is currently an empty callback."),
            ("src/daemon/account-registry.ts", "Read", "Already emits the warning."),
            ("src/rooms/store.ts", "Read", "Delivery surface."),
        ],
        steps=[
            "Post the warning into the account's peers' rooms, since a warning only the daemon sees cannot prompt the bump it exists to request.",
            "Feed `autonomy.budgetUsd` from the parsed definition into registration, which currently passes no budget.",
            "Warn once per threshold crossing rather than on every subsequent turn.",
        ],
        acceptance=[
            "Crossing 80% posts exactly one warning naming the account and its budget.",
            "Reaching 100% parks the runs and posts a message saying a bump is required.",
            "A bump resumes the account and delivers any backlog.",
            "Re-crossing after a bump warns again.",
        ],
        depends_on=["T-502"],
        out_of_scope=["Subscription accounts, which never take this path."],
    ),
]

TASK_FILE = {t.id: f"{t.id}-{t.slug}.md" for t in TASKS}


# ── Index documents ───────────────────────────────────────────────────────────

STATUS_LEGEND = [
    ("Done", "Shipped, tested, and committed. The evidence table names the suite and commit."),
    ("In progress", "Substantially built, but at least one acceptance item is unmet. The gap is named in the epic."),
    ("Ready", "Specified and unblocked. Everything it depends on is Done."),
    ("Blocked", "Waiting on a listed dependency."),
]


def render_readme() -> str:
    total = len(TASKS)
    done = len([t for t in TASKS if t.status == "Done"])
    parts = [
        "# oh-my-agent delivery tree",
        "",
        "Every unit of work on this project, as a file you can open and act on without "
        "reading the whole history. Written so a fresh session can pick up any single task "
        "cold.",
        "",
        "## Start here",
        "",
        "1. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — what the system is and why. "
        "Read it as a design specification: every section is marked `[Implemented]`, "
        "`[Partial]`, or `[Planned]`, and where the two documents disagree this tree wins.",
        "2. [`adr/`](adr/) — the decisions, each with the alternatives that lost and the evidence behind it.",
        "3. The epic you are working in, then its task file.",
        "4. [`asset-map.md`](asset-map.md) — which task owns a given source file.",
        "",
        "## Current state",
        "",
        f"**{done} of {total} tasks Done.** Test suite: 402 passing across 18 files, `tsc --noEmit` clean.",
        "",
        "Every runtime subsystem is built and under test: workers, isolation, credentials, "
        "rooms, scheduling, and quota handling. Two things keep that from meaning finished.",
        "",
        "First, there is no operator surface. The extension entry point is an empty factory "
        "and there is no daemon binary, so nothing here can currently be launched or looked "
        "at by a human (EP-05).",
        "",
        "Second, one subsystem is verified at its wire and not at its consumer. The "
        "credential gateway's suites drive it with `fetch`, so the requester-recovery path "
        "is checked as a response shape while the client's reaction to that shape is read "
        "from upstream source rather than exercised. "
        "[T-303](tasks/T-303-client-integration.md) closes it; until then EP-03 is In "
        "progress, not Done.",
        "",
        "## Unit contract",
        "",
        "Every task file carries the same eight sections in the same order: Goal, Read first, "
        "Files this task may change, Modules and assets in play, Steps, Acceptance, and then "
        "Out of scope, Depends on, Unblocks. Anything else is drift.",
        "",
        "Task numbers are keyed to their epic: `EP-00` owns `T-0xx`, `EP-05` owns `T-5xx`. "
        "The number tells you the parent without opening anything.",
        "",
        "## Status values",
        "",
        table(["Status", "Meaning"], [[s, m] for s, m in STATUS_LEGEND]),
        "",
        "## Epics",
        "",
        table(
            ["Epic", "Title", "Status", "Tasks"],
            [
                [
                    f"[{e.id}](epics/{EPIC_FILE[e.id]})",
                    e.title,
                    e.status,
                    str(len([t for t in TASKS if t.epic == e.id])),
                ]
                for e in EPICS
            ],
        ),
        "",
        "## Sprints",
        "",
        table(
            ["Sprint", "Title", "Status", "Theme"],
            [[f"[{s.id}](sprints/{SPRINT_FILE[s.id]})", s.title, s.status, s.theme] for s in SPRINTS],
        ),
        "",
        "## Decisions",
        "",
        table(
            ["ADR", "Title", "Status"],
            [[f"[{a.id}](adr/{ADR_FILE[a.id]})", a.title, a.status] for a in ADRS],
        ),
        "",
        "## What to do next",
        "",
        "[T-303](tasks/T-303-client-integration.md) first: it needs no new modules and "
        "closes the one place a Done claim outruns its evidence.",
        "",
        "Then EP-05 in dependency order: "
        + " then ".join(f"[{t}](tasks/{TASK_FILE[t]})" for t in ["T-501", "T-502"])
        + ". After T-502 the remaining four are independent and can run in parallel.",
        "",
        "## Working rules",
        "",
        "- **Test-first, and prove the test is not vacuous.** Revert the fix, confirm the "
        "test fails, restore. This caught two hollow tests that passed without the code they "
        "claimed to cover.",
        "- **Tests call production builders.** A test that rebuilds what production builds "
        "will keep passing while production drifts (see [ADR-008](adr/ADR-008-tests-share-production-builders.md)).",
        "- **A task listing more than about six files is too large.** Split it.",
        "- **No phased delivery.** The first shipped version has every documented subsystem "
        "working.",
        "",
        "## Regenerating",
        "",
        "These files are generated. Edit [`gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py) "
        "and re-run it; do not hand-edit the output, because hand edits are lost on the next run.",
        "",
        "```sh",
        "python3 scripts/gen-delivery-docs.py",
        "```",
    ]
    return "\n".join(parts) + "\n"


def render_asset_map() -> str:
    owner: dict[str, list[str]] = {}
    toucher: dict[str, list[str]] = {}
    for t in TASKS:
        for path, role, _ in t.assets:
            if role in ("New", "Edited"):
                owner.setdefault(path, []).append(t.id)
            else:
                toucher.setdefault(path, []).append(t.id)

    rows = []
    for path in sorted(set(owner) | set(toucher)):
        owners = ", ".join(f"[{i}](tasks/{TASK_FILE[i]})" for i in owner.get(path, [])) or "—"
        readers = ", ".join(f"[{i}](tasks/{TASK_FILE[i]})" for i in toucher.get(path, [])) or "—"
        exists = "yes" if os.path.exists(os.path.join(ROOT, path)) else "not yet"
        rows.append([f"`{path}`", exists, owners, readers])

    return "\n".join(
        [
            "# Asset map",
            "",
            "Every module the delivery tree names, the task that owns it, and the tasks that "
            "read it. Use this to find the owning task before editing a file, so two tasks do "
            "not edit the same module from different directions.",
            "",
            "`Exists` is computed when this file is generated: `not yet` means the module is "
            "specified but unwritten.",
            "",
            table(["Path", "Exists", "Owned by", "Read by"], rows),
        ]
    ) + "\n"


# ── Emit ──────────────────────────────────────────────────────────────────────


def main() -> None:
    if os.path.isdir(DELIVERY):
        shutil.rmtree(DELIVERY)
    for sub in ("epics", "sprints", "tasks", "adr"):
        os.makedirs(os.path.join(DELIVERY, sub), exist_ok=True)

    written: list[str] = []

    def emit(relpath: str, body: str) -> None:
        full = os.path.join(DELIVERY, relpath)
        with open(full, "w") as fh:
            fh.write(body)
        written.append(full)

    emit("README.md", render_readme())
    emit("asset-map.md", render_asset_map())
    for a in ADRS:
        emit(os.path.join("adr", ADR_FILE[a.id]), render_adr(a))
    for e in EPICS:
        emit(os.path.join("epics", EPIC_FILE[e.id]), render_epic(e, [t for t in TASKS if t.epic == e.id]))
    for s in SPRINTS:
        emit(os.path.join("sprints", SPRINT_FILE[s.id]), render_sprint(s, [t for t in TASKS if t.sprint == s.id]))
    for t in TASKS:
        emit(os.path.join("tasks", TASK_FILE[t.id]), render_task(t))

    print(f"wrote {len(written)} files")
    verify(written)


# ── Verification gates ────────────────────────────────────────────────────────

FORBIDDEN = {"\u00a0": "non-breaking space", "\ufffd": "replacement char"}
SECRET_MARKERS = [
    r"\bsk-[A-Za-z0-9]{16,}",
    r"\bghp_[A-Za-z0-9]{20,}",
    r"BEGIN [A-Z ]*PRIVATE KEY",
    r"\bxoxb-[A-Za-z0-9-]{10,}",
    r"_TOKEN=\S+",
]


def verify(written: list[str]) -> None:
    import re

    failures: list[str] = []

    # Gate 1: forbidden characters.
    hits = 0
    for f in written:
        text = open(f).read()
        for ch, name in FORBIDDEN.items():
            if ch in text:
                hits += text.count(ch)
                failures.append(f"{os.path.relpath(f, ROOT)}: contains {name}")
    print(f"gate: forbidden characters -> {hits} (expect 0)")

    # Gate 2: secret markers.
    leaks = 0
    for f in written:
        text = open(f).read()
        for m in SECRET_MARKERS:
            for hit in re.findall(m, text):
                leaks += 1
                failures.append(f"{os.path.relpath(f, ROOT)}: matches {m!r} -> {hit[:12]}")
    print(f"gate: credential markers -> {leaks} (expect 0)")

    # Gate 3: relative link resolution. A gate that checks 0 links passes silently,
    # so report the total checked alongside the broken count.
    checked = broken = 0
    link = re.compile(r"\]\(([^)]+)\)")
    for f in written:
        base = os.path.dirname(f)
        for target in link.findall(open(f).read()):
            if target.startswith(("http://", "https://", "#")):
                continue
            checked += 1
            resolved = os.path.normpath(os.path.join(base, target.split("#")[0]))
            if not os.path.exists(resolved):
                broken += 1
                failures.append(f"{os.path.relpath(f, ROOT)}: broken link -> {target}")
    print(f"gate: relative links -> {checked} checked, {broken} broken (expect 0 broken)")

    # Gate 4a: every evidence path must exist on disk. Rendering a missing path
    # as plain text (rather than a link) hides it from the link gate, so this
    # gate is what actually catches a wrong anchor. Four bad OMP paths reached
    # the first draft this way.
    anchors = missing_anchor = 0
    for holder, pairs in (
        [(t.id, t.evidence) for t in TASKS] + [(a.id, a.evidence) for a in ADRS]
    ):
        for claim, anchor in pairs:
            path = anchor.split(":")[0]
            # A bare commit sha (or list of them) is not a path. Anything that
            # looks like a file, including a repo-root file with no slash, must
            # exist: requiring a slash left `ARCHITECTURE.md:141` unchecked.
            if re.fullmatch(r"[0-9a-f]{7}(, [0-9a-f]{7})*", anchor):
                continue
            if "/" not in path and "." not in path:
                continue
            anchors += 1
            if not os.path.exists(os.path.join(ROOT, path)):
                missing_anchor += 1
                failures.append(f"{holder}: evidence path does not exist -> {path}")
    print(f"gate: evidence paths -> {anchors} checked, {missing_anchor} missing (expect 0)")

    # Gate 4b: an asset a task only READS must already exist. A "New" or
    # "Edited" asset may legitimately not exist yet.
    owned = {p for t in TASKS for p, role, _ in t.assets if role in ("New", "Edited")}
    reads = missing_read = 0
    for t in TASKS:
        for path, role, _ in t.assets:
            if role in ("New", "Edited"):
                continue
            reads += 1
            if os.path.exists(os.path.join(ROOT, path)):
                continue
            # A module a Ready task will create is a legitimate forward
            # dependency, but only if some task actually owns it AND this task
            # depends on that owner. Otherwise it is a dangling reference.
            owner = next((o.id for o in TASKS for p, r, _ in o.assets
                          if p == path and r in ("New", "Edited")), None)
            if owner and owner in t.depends_on:
                continue
            missing_read += 1
            failures.append(
                f"{t.id}: reads {path} which does not exist"
                + (f" and is owned by {owner}, not in depends_on" if owner else " and no task owns it")
            )
    print(f"gate: read-only assets -> {reads} checked, {missing_read} missing (expect 0)")

    # Gate 4c: every evidence row is anchored to a path or identifier.
    rows = unanchored = 0
    for t in TASKS:
        for claim, anchor in t.evidence:
            rows += 1
            if not ("/" in anchor or re.fullmatch(r"[0-9a-f]{7}(, [0-9a-f]{7})*", anchor)):
                unanchored += 1
                failures.append(f"{t.id}: unanchored evidence {claim!r} -> {anchor!r}")
    for a in ADRS:
        for claim, src in a.evidence:
            rows += 1
            if "/" not in src and ":" not in src:
                unanchored += 1
                failures.append(f"{a.id}: unanchored evidence {claim!r} -> {src!r}")
    print(f"gate: evidence rows -> {rows} checked, {unanchored} unanchored (expect 0)")

    # Gate 5a: every task file carries exactly the eight declared sections, in
    # order. A ninth heading is drift, which is the failure the contract exists
    # to prevent.
    expected = [
        "## Goal",
        "## Read first",
        "## Files this task may change",
        "## Modules and assets in play",
        "## Steps",
        "## Acceptance",
        "## Out of scope",
        "## Depends on",
        "## Unblocks",
    ]
    drifted = 0
    for f in written:
        if "/tasks/" not in f:
            continue
        headings = [ln.rstrip() for ln in open(f).read().splitlines() if ln.startswith("##")]
        if headings != expected:
            drifted += 1
            extra = [h for h in headings if h not in expected]
            failures.append(
                f"{os.path.relpath(f, ROOT)}: section drift"
                + (f", unexpected {extra}" if extra else f", got {headings}")
            )
    print(f"gate: task sections -> {len(TASKS)} files, {drifted} drifted (expect 0)")

    # Gate 5b: task contract shape.
    missing = 0
    for t in TASKS:
        if not t.acceptance or not t.steps or not t.files or not t.assets:
            missing += 1
            failures.append(f"{t.id}: incomplete contract")
        for dep in t.depends_on + t.unblocks:
            if dep not in TASK_FILE and dep != "Nothing.":
                missing += 1
                failures.append(f"{t.id}: unknown dependency {dep}")
    print(f"gate: task contract -> {len(TASKS)} tasks, {missing} incomplete (expect 0)")

    if failures:
        print("\nFAILURES:")
        for f in failures[:40]:
            print(f"  {f}")
        raise SystemExit(1)
    print("\nall gates pass")


if __name__ == "__main__":
    main()
