#!/usr/bin/env python3
"""Generate the oh-my-agent delivery tree.

One generator, one contract. Hand-written unit files diverge by file three;
this keeps 40+ documents structurally identical and makes a contract change a
one-line edit.

Run: python3 scripts/gen-delivery-docs.py
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass, field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DELIVERY = os.path.join(ROOT, "docs", "delivery")

# ── Contract ──────────────────────────────────────────────────────────────────

# One vocabulary for every unit in the tree. The dataclasses, the README legend,
# and the gates all read this list, so adding a sixth status is one edit and a
# typo in a task literal is a gate failure rather than a new status nobody
# defined.
STATUS_LEGEND: list[tuple[str, str]] = [
    ("Done", "Shipped, tested, and committed. The evidence table names the suite and commit."),
    ("In progress", "Started, and at least one acceptance item is unmet. The gap is named in the epic."),
    ("Ready", "Specified and unblocked. Everything it depends on is Done."),
    ("Blocked", "Waiting on a listed dependency that is not Done."),
    ("Planned", "Specified, but not queued: nothing is waiting on it and nobody has picked it up."),
]
STATUSES: tuple[str, ...] = tuple(s for s, _ in STATUS_LEGEND)

ADR_STATUS_LEGEND: list[tuple[str, str]] = [
    ("Accepted", "In force. The code is expected to match it, and a change needs a new ADR."),
    ("Proposed", "Written down and argued, but nothing is built against it yet."),
]
ADR_STATUSES: tuple[str, ...] = tuple(s for s, _ in ADR_STATUS_LEGEND)


@dataclass
class Task:
    id: str
    slug: str
    title: str
    epic: str
    sprint: str
    status: str  # one of STATUSES
    goal: str
    read_first: list[tuple[str, str]]
    files: list[str]
    assets: list[tuple[str, str, str]]  # (path, role, note)
    steps: list[str]
    acceptance: list[str]
    out_of_scope: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    evidence: list[tuple[str, str]] = field(default_factory=list)  # (claim, anchor)
    # No `unblocks`: it is the inverse of `depends_on` and is derived at render
    # time. Authoring both halves of an edge is how T-302, T-503, and T-603 all
    # ended up pointing at tasks that did not point back.


@dataclass
class Epic:
    id: str
    slug: str
    title: str
    outcome: str
    why: str
    scope: list[str]
    non_goals: list[str]
    acceptance: list[str]
    adrs: list[str] = field(default_factory=list)
    # Status is derived from the tasks inside. An override is allowed for the
    # case derivation cannot see, but it must say why, in the document, next to
    # the status it contradicts.
    status_override: str | None = None
    status_note: str | None = None


@dataclass
class Sprint:
    id: str
    slug: str
    title: str
    theme: str
    status_override: str | None = None
    status_note: str | None = None


@dataclass
class ADR:
    id: str
    slug: str
    title: str
    status: str  # one of ADR_STATUSES
    context: str
    decision: str
    consequences: list[str]
    alternatives: list[tuple[str, str]]  # (option, why rejected)
    evidence: list[tuple[str, str]]


def container_status(unit: Epic | Sprint, children: list[Task]) -> tuple[str, str | None]:
    """Derive an epic's or sprint's status from the tasks it holds.

    A container has no independent progress: it is exactly as far along as its
    children. Writing the status by hand let `EP-05` sit at `Ready` while
    holding six unstarted tasks, and nothing could tell the difference between
    that and a deliberate claim. Returns `(status, annotation)`; the annotation
    is non-empty only for a manual override.
    """
    if unit.status_override:
        return unit.status_override, unit.status_note
    if not children:
        return "Planned", None
    have = {t.status for t in children}
    if have == {"Done"}:
        return "Done", None
    if "In progress" in have:
        return "In progress", None
    if "Ready" in have:
        return "Ready", None
    if "Blocked" in have:
        return "Blocked", None
    return "Planned", None


def status_cell(status: str, note: str | None) -> str:
    return f"{status} ({note})" if note else status


def anchor_path(anchor: str) -> str:
    """The file part of an evidence anchor.

    Anchors are either `path`, `path:lines`, or `path §N`. Splitting on `:`
    alone kept `ARCHITECTURE.md §7` intact only by accident, so the section form
    is stripped explicitly.
    """
    return anchor.split(":")[0].split(" §")[0].strip()


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
            p = anchor_path(anchor)
            linkable = "/" in anchor and os.path.exists(os.path.join(ROOT, p))
            ev_rows.append([c, f"[`{anchor}`]({rel(d, p)})" if linkable else f"`{anchor}`"])
        parts.append(table(["Claim", "Anchor"], ev_rows))
    parts += ["", "## Out of scope", ""]
    parts += [f"- {x}" for x in (t.out_of_scope or ["Nothing deferred."])]
    parts += ["", "## Depends on", ""]
    parts += [f"- {x}" for x in (t.depends_on or ["Nothing."])]
    parts += ["", "## Unblocks", ""]
    parts += [f"- {x}" for x in (DEPENDENTS[t.id] or ["Nothing."])]
    return "\n".join(parts) + "\n"


def render_epic(e: Epic, tasks: list[Task]) -> str:
    status, note = container_status(e, tasks)
    parts = [
        f"# {e.id} — {e.title}",
        "",
        f"**Status:** {status_cell(status, note)}",
        "",
        "*Derived from the tasks below.*" if not note else f"*Overridden: {note}.*",
        "",
        "## Outcome",
        "",
        e.outcome,
    ]
    parts += ["", "## Why this is its own epic", "", e.why, "", "## In scope", ""]
    parts += [f"- {x}" for x in e.scope]
    parts += ["", "## Not in scope", ""]
    parts += [f"- {x}" for x in e.non_goals]
    parts += ["", "## Acceptance", ""]
    for a in e.acceptance:
        parts.append(f"- [{'x' if status == 'Done' else ' '}] {a}")
    if status == "In progress":
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
    status, note = container_status(s, tasks)
    parts = [
        f"# {s.id} — {s.title}",
        "",
        f"**Status:** {status_cell(status, note)}",
        "",
        "*Derived from the tasks below.*" if not note else f"*Overridden: {note}.*",
        "",
        "## Theme",
        "",
        s.theme,
    ]
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
            path = anchor_path(s)
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
            ("Layer 1 is opt-in", "ARCHITECTURE.md §7"),
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
            ("Upstream produces the block deadline", "ARCHITECTURE.md §10 open question 5"),
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
            ("Delegation contract", "ARCHITECTURE.md §5.1"),
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
            ("Engineering practice", "ARCHITECTURE.md §11"),
        ],
    ),
    ADR(
        id="ADR-009",
        slug="threads-and-reactions",
        title="Conversation gains threads and reactions; reactions carry agent status",
        status="Proposed",
        context=(
            "The room store is a flat append-only log with per-agent read cursors, which is "
            "enough for one agent answering one human. It stops being enough once several "
            "agents work a channel at once: replies interleave, and a human cannot tell "
            "which agent picked up which request without reading every turn."
        ),
        decision=(
            "Add `parent_id` to messages and a uniquely-keyed `reactions` table. Threads are "
            "derived from the parent chain rather than stored twice. Agents may set "
            "reactions from a small declared emoji set, which doubles as machine-readable "
            "status: picked up, finished, failed."
        ),
        consequences=[
            "A human scanning a channel sees per-message state without reading every turn.",
            "Status costs no extra messages, so a busy channel does not fill with acknowledgements.",
            "The emoji set is closed, because a free-form vocabulary cannot render as status.",
            "Wake semantics are deliberately unchanged: a threaded reply is still an unread message, and a reaction never marks a message read.",
            "The console cannot be a thin CRUD layer over SQLite. `Supervisor.register` caches each peer's rooms in a private `Set` that `post()` filters against, so a membership write that stops at the database leaves a running agent deaf to its new channel (T-605).",
        ],
        alternatives=[
            ("Store a thread root alongside the parent", "Two pointers can disagree; a derived root cannot."),
            ("A separate status field on messages", "Only the author could set it, so it could not express another agent picking up a human's request."),
            ("Free-form reactions", "The UI could not render arbitrary emoji as status, and agents would invent divergent conventions."),
        ],
        evidence=[
            ("Current flat message model", "src/rooms/store.ts"),
            ("Delivery is subscription-scoped and must stay so", "src/daemon/supervisor.ts"),
        ],
    ),
    ADR(
        id="ADR-010",
        slug="mit-license",
        title="MIT license, chosen by the repository owner",
        status="Accepted",
        context=(
            "The repository is public and ships package metadata pointing at it. A "
            "public repo with no `LICENSE` is not public domain: it is all-rights-reserved "
            "by default, so a reader may look but has no grant to use, fork, or depend on "
            "it. Adding a `license` field to `package.json` while no license text exists "
            "would be worse than the silence, because tooling would report a grant that was "
            "never made. The choice was deferred to the owner rather than made by the "
            "generator, because a license binds every future contributor."
        ),
        decision=(
            "MIT. The owner chose it on 2026-08-27, and the two halves land in one change: "
            "the `LICENSE` text and the `license` field in `package.json`, so tooling never "
            "reports a grant without text behind it."
        ),
        consequences=[
            "T-703 ships both halves together; a `license` field without a `LICENSE` file (or the reverse) is the mismatch this record exists to prevent.",
            "Publishing to a registry is unblocked; the deferral was the only thing standing in its way.",
            "Contributors get a permissive grant with no patent clause; that simplicity is accepted as the cost of MIT.",
        ],
        alternatives=[
            ("Keep deferring", "A public repo without a license is all-rights-reserved; the deferral was a forcing function, not an end state."),
            ("Apache-2.0", "The patent grant is real, but the project is a local plugin and MIT's brevity fits its surface."),
            ("Set `license: UNLICENSED`", "Accurate for a private package, misleading for a public repository that intends to be usable."),
        ],
        evidence=[
            ("MIT license text", "./LICENSE"),
            ("Package license field", "./package.json"),
        ],
    ),
    ADR(
        id="ADR-011",
        slug="agent-hierarchy",
        title="Persistent child agents are spawn-time state; kill cascades",
        status="Accepted",
        context=(
            "A peer must be able to deploy persistent child peers (a CEO standing up a "
            "CTO, staff engineers, QA) that live under it in a tree, survive restarts, and "
            "stay distinct from native `task` subagents, which are temporary and in-run. "
            "The design had to answer where parentage lives, how the daemon learns the "
            "spawner's identity over an unauthenticated shared socket, whether spawn "
            "carries an inline definition, what children inherit, and what happens to "
            "children when a parent dies."
        ),
        decision=(
            "Parentage is daemon spawn-time state (an `agents.parent` column), never "
            "frontmatter — the same definition deploys under different parents and the "
            "strict parser stays untouched. The spawning worker self-asserts its name in "
            "`agent_spawn`'s optional `parent` param; the socket trusts every caller "
            "equally today, so parentage is cooperative metadata and nothing (budget, kill "
            "authority, room ACLs) may ever be enforced off it until real connection "
            "identity exists. Creation is two calls: `agent_create` writes a "
            "parse-validated definition to the peer store, then `agent_spawn` starts it — "
            "an LLM caller gets a validation checkpoint before anything runs. Children "
            "inherit only the parent's account and an auto-created family channel "
            "`#<parent>-team`; rooms and budget are explicit, because a shared budget lets "
            "one runaway child starve its siblings invisibly. `kill` cascades to the "
            "subtree by default (with an explicit keep-children reparent), and at boot an "
            "agent whose parent is gone is refused and flagged orphaned rather than "
            "silently resumed."
        ),
        consequences=[
            "The frozen protocol grows additively under the no-bump policy: agent_create, definition_get, definition_update, a parent field on spawn, and parent/children on status.",
            "A misbehaving peer can claim any parent — documented as cosmetic metadata, so no enforcement may ever be built on it without a connection-identity task first.",
            "Orphanhood is an impossible steady state: cascades and the boot refusal remove the cleanup chore.",
            "Native `task` remains the only temporary-subagent path; hierarchy never competes with it (ADR-007 stands).",
        ],
        alternatives=[
            ("Parent in the definition frontmatter", "Freezes topology at parse, breaks definition portability across installs, and forces the strict parser to grow a runtime-only key."),
            ("Inline definition in agent_spawn params", "An LLM caller would emit full frontmatter inside JSON; the strict parser turns every hallucinated key into a mid-spawn throw with no validation checkpoint."),
            ("Children inherit rooms and budget", "Room inheritance leaks operator-facing channels to every child; budget inheritance lets one runaway child starve siblings without a trace."),
            ("Orphan cleanup sweep", "A sweeper runs after the failure; refusing the wake and cascading kills make the state impossible instead."),
        ],
        evidence=[
            ("Hierarchy design in the tree", "docs/delivery/tasks/T-802-daemon-hierarchy.md"),
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
            "A frozen control-socket protocol the daemon serves and every client speaks.",
            "A `daemon` entry point that boots the broker, gateway, store, and supervisor.",
            "Peer store loading definitions from the private user and project paths.",
            "Durable daemon state: agents, runs, and schedules that survive a restart.",
            "Toolbelt extension exposing chat and agent tools to workers.",
            "Wake filters: mention and room subscription semantics in the delivery path.",
            "TUI commands, a status widget, and ask-dialogs.",
        ],
        non_goals=[
            "Changing any runtime invariant already covered by EP-02 through EP-04.",
        ],
        acceptance=[
            "`omp-agent daemon` starts, serves a socket, and survives its launching terminal closing.",
            "The socket answers every method the protocol declares, or reports method-not-found with the protocol version.",
            "Agents, runs, and schedules survive a daemon restart, and orphaned worker directories are swept at boot.",
            "`/agents` lists peers with state, and shows a shield only for sandboxed ones.",
            "`/rooms` reads and posts as `@you`.",
            "A worker can call `chat_send` and `chat_wait` against the daemon's bus.",
            "An `@name` mention wakes that peer when it opted in, and a room post wakes only its subscribers.",
        ],
        adrs=["ADR-001", "ADR-005"],
    ),
    Epic(
        id="EP-06",
        slug="web-console",
        title="Web console: manage agents and channels from a browser",
        outcome=(
            "A browser UI where a human creates agents and channels, puts agents in "
            "channels, and holds a Slack-like conversation with them: replies, threads, "
            "and emoji reactions."
        ),
        why=(
            "The TUI (EP-05) reaches whoever is at the terminal that launched the daemon. "
            "Long-lived agents outlive that terminal by design, so the natural way to check "
            "on them is a URL. This epic is also where the message model stops being a flat "
            "log: threads keep several agents talking at once from becoming unreadable, and "
            "reactions double as machine-readable status an agent can set on a message "
            "without adding noise to the channel."
        ),
        scope=[
            "Message model: parent/child replies, thread roots, and reactions.",
            "HTTP and WebSocket API over the daemon's existing state.",
            "Browser client: channel list, transcript, thread pane, composer.",
            "Create and configure agents and channels from the UI.",
            "Membership: add and remove agents from channels, applied to live workers.",
            "Reactions as agent status, settable through the toolbelt.",
        ],
        non_goals=[
            "Multi-user accounts or auth beyond the daemon's single-operator model.",
            "Replacing the TUI; both talk to the same daemon.",
            "Editing or deleting another participant's messages.",
        ],
        acceptance=[
            "A channel created in the UI is immediately visible to a worker. Worker-side channel creation is deliberately not in this epic: no task builds such a tool, and an acceptance item nothing implements is a promise that quietly fails.",
            "An agent added to a channel receives its next message.",
            "A reply appears in a thread without cluttering the channel root.",
            "An agent can set a reaction, and it appears in an open browser without a refresh.",
            "A membership change reaches a running agent on the next post, with no restart.",
            "Closing the browser does not stop or park any agent.",
        ],
        adrs=["ADR-009"],
    ),
    Epic(
        id="EP-07",
        slug="release-readiness",
        title="Release readiness: CI, lint, and a README a stranger can act on",
        outcome=(
            "Every push is type-checked, tested, and checked for delivery-doc drift by a "
            "machine, the code has one enforced style, and the repository's front door "
            "explains what this is and how to run it."
        ),
        why=(
            "Everything else in this tree is verified by a suite somebody has to remember "
            "to run. That is not verification, it is a habit, and habits do not survive a "
            "handover. This epic is also where the delivery tree itself becomes checkable: "
            "the generator is only a source of truth if a stale committed tree fails a "
            "build rather than sitting there looking authoritative."
        ),
        scope=[
            "GitHub Actions workflow: install, typecheck, test, and a delivery-doc regeneration diff.",
            "Biome configuration plus lint and format scripts.",
            "Root README and the package metadata that points at the repository.",
        ],
        non_goals=[
            "Publishing to a registry, which is blocked on the license decision (ADR-010).",
            "Choosing a license; that is the owner's call, recorded as deferred.",
            "Release automation, tagging, or changelog generation.",
        ],
        acceptance=[
            "A push runs `tsc --noEmit` and `bun test` and fails the build on either.",
            "A commit whose `docs/delivery/` differs from what the generator produces fails CI.",
            "`bun run lint` reports the same result locally and in CI.",
            "The root README explains what the plugin is, how to install it, and where the delivery tree lives.",
            "`package.json` carries repository, homepage, bugs, keywords, an engines constraint, and the MIT license field matching `LICENSE` (ADR-010).",
        ],
        adrs=["ADR-010"],
    ),
    Epic(
        id="EP-08",
        slug="agent-hierarchy",
        title="Agent hierarchy and authoring",
        outcome=(
            "A peer can deploy persistent child peers under itself — a CEO standing up a "
            "CTO and staff — with the tree visible to the operator, children surviving "
            "restarts, and creation guided by shipped skills instead of code archaeology."
        ),
        why=(
            "The native `task` tool is a temporary subagent: its transcript folds into the "
            "parent run and it is gone. Standing teams need durable peers with their own "
            "lifecycle, rooms, and budget, parented so the operator can see who deployed "
            "whom — and without a kill cascade, a dead parent leaves children spending and "
            "messaging forever with no owner."
        ),
        scope=[
            "Protocol additions: `agent_create`, `definition_get`, `definition_update`, a `parent` field on `agent_spawn`, and `parent`/`children` on status (additive, no version bump).",
            "Daemon hierarchy state: `agents.parent`, cycle rejection, kill cascade, orphan refusal at boot, family channel, account-only inheritance.",
            "Toolbelt authoring tools with child-vs-task selection guidance.",
            "Shipped skills for agent and subagent authoring, discovered by OMP and materialized into workers.",
        ],
        non_goals=[
            "Enforcing anything off parentage — it is cooperative metadata until the socket has connection identity (ADR-011).",
            "Any change to native `task` recursion or spawn policy.",
        ],
        acceptance=[
            "A worker creates and spawns a child through the toolbelt, and the child appears under it in status output and the TUI.",
            "Killing a parent stops its subtree; a boot refuses to wake an agent whose parent is gone.",
            "A cycle (`A` under `B` under `A`) is rejected at spawn.",
            "A child never inherits its parent's rooms or budget by default.",
            "The shipped skills are discovered by OMP's real `loadSkills` and a worker selecting them receives them in its materialized root.",
        ],
        adrs=["ADR-011", "ADR-007"],
    ),
    Epic(
        id="EP-09",
        slug="tui-management",
        title="Full TUI management surface",
        outcome=(
            "From inside the OMP TUI, an operator browses the agent tree in a full-screen "
            "manager and edits agents, their models, and their definitions without leaving "
            "the session or hand-editing files."
        ),
        why=(
            "The hierarchy makes the flat `/agents` list a lie, and definitions today are "
            "edited by writing markdown by hand. OMP's extension surface supports a real "
            "full-screen overlay plus editor and selection dialogs, so management belongs "
            "inside the TUI the operator already lives in."
        ),
        scope=[
            "Tree rendering of the agent hierarchy in `/agents` and the spawn flow's parent picker.",
            "A full-screen manager (custom overlay component): browse, inspect, edit, kill with cascade choice, logs, inject.",
            "Definition and model editing through editor dialogs, persisting through the daemon's write path.",
        ],
        non_goals=[
            "RPC/print-mode parity — the manager is TUI-only by design and degrades to the existing commands.",
            "Editing schedules or accounts (existing commands already cover those).",
        ],
        acceptance=[
            "The tree renders parented agents nested under their parents.",
            "A definition edited in the manager persists, reparses cleanly, and triggers the staleness rebuild on next delivery.",
            "A model change takes effect on the worker's next session.",
            "The manager never throws into the TUI when the daemon is absent.",
        ],
        adrs=["ADR-011"],
    ),
    Epic(
        id="EP-10",
        slug="production-wiring",
        title="Production wiring: serving, usage, and deferred hardening",
        outcome=(
            "The console is reachable for real — the daemon serves the API and the client "
            "behind an operator token — and budgets are fed by actual usage. The deferred "
            "hardening (connection identity, credential-env scoping, in-process workers) is "
            "specified with its trigger so the deferral is a decision, not an oversight."
        ),
        why=(
            "Three subsystems were built and tested without a production seam: the console "
            "API is never mounted by the daemon, the meter is never fed, and the worker pid "
            "is never recorded. Each is small, each is load-bearing for actually operating "
            "the system, and each was out of scope for the epic that built its subsystem."
        ),
        scope=[
            "Mounting the console API at boot with the operator-token lifecycle and static client serving.",
            "Account-to-credential binding and gateway-usage polling into the meter.",
            "Worker pid from the lifecycle onto the wire and into the registry.",
            "Specified-but-parked hardening: connection identity, credential-env scoping, in-process workers.",
        ],
        non_goals=[
            "Any new UI surface; this epic is backend seams for the surfaces that exist.",
            "Non-loopback exposure of the console (that is what triggers T-1004).",
        ],
        acceptance=[
            "A browser reaches the console served by the daemon itself, with the token flow documented in docs/web-console.md.",
            "A metered account's meter moves with real usage, and the 80%/park/bump path fires on it.",
            "Status and the registry report a real pid for a running worker.",
        ],
        adrs=["ADR-011"],
    ),
]

EPIC_FILE = {e.id: f"{e.id}-{e.slug}.md" for e in EPICS}
EPIC_TITLE = {e.id: e.title for e in EPICS}

# ── Sprints ───────────────────────────────────────────────────────────────────

SPRINTS = [
    Sprint(id="SP-01", slug="contracts-and-parsing", title="Contracts and parsing",
           theme="Pin how OMP actually behaves, and turn a peer file into a typed definition."),
    Sprint(id="SP-02", slug="isolation", title="Isolation",
           theme="Materialized roots, compiled sandbox policies, and a launch gate that fails closed."),
    Sprint(id="SP-03", slug="credentials", title="Credentials",
           theme="A scoped gateway so a worker sees one account, not the vault, "
                 "verified against the real client that consumes it."),
    Sprint(id="SP-04", slug="autonomy", title="Autonomy",
           theme="Workers, rooms, schedules, quota parking, and unattended resume."),
    Sprint(id="SP-05", slug="operator-surface", title="Operator surface",
           theme="The parts a human touches: protocol, daemon entry point, persistence, "
                 "toolbelt, and TUI."),
    Sprint(id="SP-06", slug="conversation-model", title="Conversation model",
           theme="Threads, replies, and reactions in the store, then over the wire."),
    Sprint(id="SP-07", slug="web-console", title="Web console",
           theme="The browser client and the daemon API behind it."),
    Sprint(id="SP-08", slug="release-readiness", title="Release readiness",
           theme="The things that make the repository checkable by a machine and "
                 "explicable to a stranger: CI, lint, and a README."),
    Sprint(id="SP-09", slug="agent-hierarchy", title="Agent hierarchy",
           theme="Persistent child peers under a parent: spawn-time parentage, cascades, "
                 "and the authoring protocol and skills behind them."),
    Sprint(id="SP-10", slug="tui-management", title="TUI management",
           theme="The full-screen manager: browse the tree, edit definitions and models, "
                 "steer agents without leaving the TUI."),
    Sprint(id="SP-11", slug="production-wiring", title="Production wiring",
           theme="The console served for real, budgets fed by real usage, and the "
                 "hardening deferred to a named trigger."),
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
        files=["package.json", "tsconfig.json", "src/extension/index.ts", "tests/scaffold.test.ts"],
        assets=[
            ("package.json", "New", "Declares `omp.extensions`."),
            ("tsconfig.json", "New", "Strict compiler settings the `typecheck` script runs against."),
            ("src/extension/index.ts", "New", "Extension factory; body lands in T-504."),
            ("tests/scaffold.test.ts", "New", "4 tests; asserts the manifest wiring."),
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
            ("tests/harness.test.ts", "New", "8 tests; covers both fixtures."),
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
        depends_on=["T-001"],
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
        depends_on=["T-002"],
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
        depends_on=["T-002"],
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
        depends_on=["T-002"],
    ),
    Task(
        id="T-007", slug="hermetic-child-environments", title="Hermetic child-process environments",
        epic="EP-00", sprint="SP-01", status="Done",
        goal="A test that spawns a child gets the environment it asked for, not the one the developer's shell happens to export.",
        read_first=[ARCH, ("Discovery contract", "tests/contracts/discovery.contract.test.ts"), ("Harness", "tests/harness.test.ts")],
        files=["tests/fixtures/hermetic-env.ts", "tests/contracts/discovery.contract.test.ts"],
        assets=[
            ("tests/fixtures/hermetic-env.ts", "New", "`hermeticChildEnv`: scrubbed copy of `process.env` plus overrides."),
            ("tests/contracts/discovery.contract.test.ts", "Edited", "Spawns children through the fixture instead of spreading `process.env`."),
            ("tests/fixtures/temp-agent-dir.ts", "Read", "Supplies the synthetic root the overrides point at."),
        ],
        steps=[
            "Scrub every config-root selector OMP consults from the inherited environment: `PI_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and the profile variables.",
            "Apply the caller's overrides last, so the synthetic `HOME`, `XDG_*`, and agent dir are the only values in play.",
            "Route the discovery contract's child spawns through the fixture rather than spreading `process.env`, since that spread is exactly how a developer's exported `PI_CONFIG_DIR` silently reroutes a synthetic-home test into their real profile — the test then passes while asserting nothing.",
            "Keep the scrub list in one place so a newly added selector is one edit, not a hunt through every suite that spawns a child.",
        ],
        acceptance=[
            "A child spawned through the fixture sees none of the host's config-root selectors.",
            "With a poisoned `PI_CONFIG_DIR` exported, the discovery contract still resolves against the synthetic root.",
            "The caller's overrides win over anything inherited.",
            "9 discovery-contract tests pass under a deliberately poisoned host environment.",
        ],
        evidence=[("Discovery contract, 9 tests", "tests/contracts/discovery.contract.test.ts")],
        depends_on=["T-002"],
        out_of_scope=[
            "The production worker environment, which T-205 scrubs using the same canonical list.",
            "Credential and provider variables; this task is about config-root selectors only.",
        ],
    ),
    # ── EP-01 ────────────────────────────────────────────────────────────────
    Task(
        id="T-101", slug="peer-definition-parser", title="Peer definition parser",
        epic="EP-01", sprint="SP-01", status="Done",
        goal="A markdown file with YAML frontmatter becomes a validated `PeerDefinition` with a stable fingerprint.",
        read_first=[ARCH, ("Discovery contract", "tests/contracts/discovery.contract.test.ts")],
        files=["src/shared/agent-definition.ts", "tests/agent-definition.test.ts"],
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
        depends_on=["T-003"],
    ),
    # ── EP-02 ────────────────────────────────────────────────────────────────
    Task(
        id="T-201", slug="materialization-engine", title="Synthetic worker root materialization",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="Each worker gets a private user root containing only the definitions it is allowed to see.",
        read_first=[ARCH, ("Discovery contract", "tests/contracts/discovery.contract.test.ts")],
        files=["src/daemon/materializer.ts", "tests/materializer.test.ts"],
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
        depends_on=["T-003", "T-101"],
    ),
    Task(
        id="T-202", slug="sandbox-policy-compiler", title="Typed sandbox policy compiler",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="One typed policy compiles to a macOS Seatbelt profile or Linux `bwrap` argv.",
        read_first=[ARCH],
        files=["src/worker/sandbox.ts", "tests/sandbox.test.ts"],
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
    ),
    Task(
        id="T-203", slug="sandbox-launch-gate", title="Sandbox launch gate",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="An opted-in peer launches sandboxed or does not launch.",
        read_first=[ARCH, ("Sandbox compiler", "src/worker/sandbox.ts")],
        files=["src/worker/launch-gate.ts", "tests/sandbox-gate.test.ts"],
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
        depends_on=["T-202"],
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
    Task(
        id="T-205", slug="worker-env-scrub", title="Worker env scrub",
        epic="EP-02", sprint="SP-02", status="Done",
        goal="A worker's environment cannot be rerouted by whatever the machine that launched the daemon happens to export.",
        read_first=[
            ARCH,
            ("Materializer", "src/daemon/materializer.ts"),
            ("Hermetic test env", "tests/fixtures/hermetic-env.ts"),
            ("ADR-002: private store and materialized roots", "docs/delivery/adr/ADR-002-private-store-materialized-roots.md"),
        ],
        files=[
            "src/shared/env-scrub.ts",
            "src/daemon/materializer.ts",
            "tests/fixtures/hermetic-env.ts",
            "tests/materializer.test.ts",
        ],
        assets=[
            ("src/shared/env-scrub.ts", "New", "The one canonical scrub list plus `withoutScrubbedEnvVars`."),
            ("src/daemon/materializer.ts", "Edited", "Neutralizes inherited selectors in the materialized worker env."),
            ("tests/fixtures/hermetic-env.ts", "Edited", "Consumes the production list instead of keeping its own copy."),
            ("tests/materializer.test.ts", "Edited", "Poisoned-env regression."),
        ],
        steps=[
            "Put the scrub list in `src/shared/env-scrub.ts` and have both production and the test fixture read it. Two lists is one list plus a bug: the copy that is not updated is the one that matters.",
            "Blank the selectors rather than deleting them. OMP's `RpcClient` merges the worker env over `Bun.env`, so a deleted key falls back to the host's value; only an explicit empty string overrides it.",
            "Cover every config-root selector: `PI_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and the profile variables.",
            "Apply the scrub inside materialization, where the worker env is built, so no caller can construct a worker env that skips it.",
            "Prove the regression is not vacuous: with the scrub reverted and a poisoned `PI_CONFIG_DIR` exported, the test must fail.",
        ],
        acceptance=[
            "A materialized worker env blanks every selector in the canonical list.",
            "With `PI_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` exported by the host, a worker still resolves to its own materialized root.",
            "Production and the test fixture share one scrub list, asserted by importing it in both.",
            "The poisoned-env regression fails with the scrub reverted, proving it is not vacuous.",
        ],
        depends_on=["T-201"],
        evidence=[
            ("Canonical scrub list shared by production and the test fixture", "src/shared/env-scrub.ts"),
            ("Poisoned-env regression, proven non-vacuous (materializer suite)", "tests/materializer.test.ts"),
        ],
        out_of_scope=[
            "Broader credential-env hygiene: provider API keys inherited into the daemon host env are still visible to a worker's own process env. That is a real gap and a known follow-up, but it is a credential-scoping question (EP-03's territory) rather than a config-root one, and folding it in here would mean two unrelated threat models in one change.",
        ],
    ),
]

TASKS += [
    # ── EP-03 ────────────────────────────────────────────────────────────────
    Task(
        id="T-301", slug="credential-gateway", title="Scoped per-worker credential gateway",
        epic="EP-03", sprint="SP-03", status="Done",
        goal="Each worker sees only the credentials its token is bound to, through a loopback proxy.",
        read_first=[ARCH, ("Broker contract", "tests/contracts/broker.contract.test.ts")],
        files=["src/daemon/credential-gateway.ts", "tests/credential-gateway.test.ts"],
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
        depends_on=["T-004"],
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
        epic="EP-03", sprint="SP-03", status="Done",
        goal="A stock `RemoteAuthCredentialStore` is proven to work against the gateway, including recovering from a refused shared disable.",
        read_first=[ARCH, ("Gateway", "src/daemon/credential-gateway.ts"), ("Gateway suite", "tests/credential-gateway.test.ts")],
        files=["tests/gateway-client.test.ts", "src/daemon/credential-gateway.ts"],
        assets=[
            ("tests/gateway-client.test.ts", "New", "Integration suite using the real client."),
            ("src/daemon/credential-gateway.ts", "Edited", "Shutdown defect the real client exposed."),
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
        out_of_scope=["Changing gateway filtering semantics; T-301 and T-302 own those."],
        evidence=[
            ("Real-client suite, 8 tests", "tests/gateway-client.test.ts"),
            ("Shutdown regression", "tests/credential-gateway.test.ts"),
            ("Commits", "74174ef, 9fe651e"),
        ],
    ),
    # ── EP-04 ────────────────────────────────────────────────────────────────
    Task(
        id="T-401", slug="worker-lifecycle", title="RPC worker lifecycle",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="A peer runs as a supervised child process that parks, resumes, and delegates through native `task`.",
        read_first=[ARCH, ("Spawn policy contract", "tests/contracts/spawn-policy.contract.test.ts")],
        files=["src/worker/lifecycle.ts", "tests/worker-lifecycle.test.ts"],
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
        depends_on=["T-005", "T-201", "T-203", "T-301"],
    ),
    Task(
        id="T-402", slug="room-store", title="Durable room store",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="Rooms, messages, and per-agent read cursors survive a daemon restart.",
        read_first=[ARCH],
        files=["src/rooms/store.ts", "tests/rooms.test.ts"],
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
    ),
    Task(
        id="T-403", slug="scheduler", title="Cron and one-shot scheduler",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="Schedules fire on Vixie cron semantics, and one-shot timers drive quota resume.",
        read_first=[ARCH],
        files=["src/daemon/scheduler.ts", "tests/scheduler.test.ts"],
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
    ),
    Task(
        id="T-404", slug="account-registry", title="Account registry and quota state machine",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="Quota exhaustion parks every run on the account and arms an unattended resume.",
        read_first=[ARCH, ("Scheduler", "src/daemon/scheduler.ts")],
        files=["src/daemon/quota-state.ts", "src/daemon/account-registry.ts", "tests/account-registry.test.ts"],
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
        depends_on=["T-403"],
    ),
    Task(
        id="T-405", slug="supervisor", title="Supervisor: delivery, parking, resume",
        epic="EP-04", sprint="SP-04", status="Done",
        goal="A room post reaches the right peers, and an armed timer alone restarts a parked worker and runs its backlog.",
        read_first=[ARCH, ("Worker lifecycle", "src/worker/lifecycle.ts"), ("Room store", "src/rooms/store.ts")],
        files=["src/daemon/supervisor.ts", "tests/supervisor.test.ts", "tests/end-to-end.test.ts"],
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
        id="T-510", slug="broker-hosting-resolution", title="Broker hosting resolution at boot",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="The daemon decides at boot whether to reuse a broker the user already runs or embed its own, and takes custody of the admin token either way.",
        read_first=[ARCH, ("Broker contract", "tests/contracts/broker.contract.test.ts"), ("Gateway", "src/daemon/credential-gateway.ts")],
        files=["src/daemon/boot.ts", "tests/daemon-boot.test.ts"],
        assets=[
            ("src/daemon/boot.ts", "New", "`resolveBrokerHosting`: discovery, probe, custody."),
            ("tests/daemon-boot.test.ts", "New", "14 tests."),
            ("src/daemon/credential-gateway.ts", "Read", "Fronts the resolved hosting with per-worker tokens."),
        ],
        steps=[
            "Follow OMP's own discovery chain in order: `OMP_AUTH_BROKER_URL` in the environment, then `auth.broker.*` in the agent config, then the token file. Inventing a different order would make the daemon disagree with every other OMP client on the same machine.",
            "Probe a discovered broker twice: reachable, and willing to accept the token. A configured-but-dead broker fails boot rather than silently falling back, because a silent fallback splits the user's credentials across two vaults.",
            "Treat an external broker's token as read-only: the daemon did not mint it and must not rotate or rewrite it.",
            "For the embedded case, start `startAuthBroker` over the shared vault and mint a fresh in-memory admin token per boot, so a token never outlives the process that owns it or lands on disk.",
            "Expose the hosting as a value the gateway consumes; workers never see `adminToken`.",
        ],
        acceptance=[
            "An `OMP_AUTH_BROKER_URL` in the environment wins over config and token file.",
            "A configured broker that fails either probe fails boot instead of falling back to embedded.",
            "An external broker's token is never rewritten.",
            "The embedded broker's admin token is freshly generated and not persisted.",
            "14 tests pass.",
        ],
        evidence=[("Boot suite, 14 tests", "tests/daemon-boot.test.ts")],
        depends_on=["T-004"],
        out_of_scope=[
            "Composing the rest of the daemon around this, which is T-502.",
            "Per-worker token issuance, which T-301 owns.",
        ],
    ),
    Task(
        id="T-507", slug="control-socket-protocol", title="Control-socket protocol",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="The daemon's JSON-RPC-over-unix-socket contract exists as one typed, versioned artifact that every client and the server share.",
        read_first=[ARCH, ("Test harness", "tests/harness.test.ts"), ("ADR-001: RPC subprocess workers", "docs/delivery/adr/ADR-001-rpc-subprocess-workers.md")],
        files=["src/shared/protocol.ts", "src/shared/protocol-schemas.ts", "tests/protocol.contract.test.ts"],
        assets=[
            ("src/shared/protocol.ts", "New", "Method names, request and response types, protocol version."),
            ("src/shared/protocol-schemas.ts", "New", "Runtime validation for every method's params and result."),
            ("tests/protocol.contract.test.ts", "New", "Pins the wire shape and the version field."),
        ],
        steps=[
            "Declare the method set once: `status`, `chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`, `rooms_list`, `rooms_post`, `schedules_list`, `schedules_arm`, `kill`, `bump`. Three consumers (daemon, toolbelt, TUI) are about to be written against this; a shape that lives only in the server is three shapes by the time they land.",
            "Carry a `protocolVersion` from the first commit. Adding one later means a field that is absent on old peers and present on new ones, which is exactly the ambiguity a version exists to remove.",
            "Validate params and results at the boundary rather than trusting the type system: types vanish at runtime, and the socket is where an unknown client reaches the daemon. Hand-roll the validation; this package carries no runtime dependencies and this task adds none.",
            "Define the error shape too, including method-not-found, and make it carry the server's protocol version so a mismatched client learns why rather than guessing.",
            "Keep the module free of transport and I/O. It is a contract; the moment it opens a socket it stops being shareable by both ends.",
        ],
        acceptance=[
            "Every declared method has a typed request, a typed response, and runtime validation on both.",
            "An unknown method produces the declared method-not-found error carrying the protocol version.",
            "A malformed params payload is refused at the boundary with the offending field named.",
            "The contract module imports no transport and no daemon state.",
            "Changing a method's shape fails the contract suite rather than surfacing as a runtime mismatch in T-502 or T-503.",
        ],
        depends_on=["T-002"],
        evidence=[
            ("Versioned contract artifact", "src/shared/protocol.ts"),
            ("Hand-rolled boundary validation", "src/shared/protocol-schemas.ts"),
            ("Contract suite, 14 tests", "tests/protocol.contract.test.ts"),
        ],
        out_of_scope=[
            "Serving the protocol, which is T-502.",
            "Consuming it from a worker, which is T-503.",
        ],
    ),
    Task(
        id="T-501", slug="peer-store", title="Peer store: load definitions from the private paths",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="The daemon can enumerate peer definitions from the user and project private stores.",
        read_first=[ARCH, ("Parser", "src/shared/agent-definition.ts"), ("Discovery contract", "tests/contracts/discovery.contract.test.ts")],
        files=["src/daemon/peer-store.ts", "tests/peer-store.test.ts", "agents/example-researcher.md", "agents/example-reviewer.md"],
        assets=[
            ("src/daemon/peer-store.ts", "New", "Enumerates and parses definitions."),
            ("tests/peer-store.test.ts", "New", "Shadowing, malformed files, empty store."),
            ("agents/example-researcher.md", "New", "Shipped example definition; §8 promises this directory exists."),
            ("agents/example-reviewer.md", "New", "Second example, showing `spawns:` and room subscriptions."),
            ("src/shared/agent-definition.ts", "Read", "`parsePeerDefinition` already exists; do not reimplement parsing."),
            ("src/daemon/materializer.ts", "Read only, not edited by this task", "Consumes the loaded definitions."),
        ],
        steps=[
            "Read `~/.omp/agent/oh-my-agent/agents/*.md` and `<project>/.omp/oh-my-agent/agents/*.md`.",
            "Let a project definition shadow a user definition of the same name, matching OMP's own precedence so users are not surprised.",
            "Parse each through `parsePeerDefinition`; surface a parse failure with its file path rather than skipping the file silently, since a silently skipped peer looks identical to a peer that never existed.",
            "Treat a missing or empty store directory as an empty listing. A first run has no store, and a daemon that cannot boot until the user has written an agent is a daemon nobody gets to try.",
            "Ship two example definitions under `agents/`, which the architecture's repo layout already promises: a parser with no example is a schema users reverse-engineer from source.",
            "Expose lookup by name plus a full listing for `/agents`.",
        ],
        acceptance=[
            "Definitions load from both stores, with project shadowing user.",
            "Neither path is an OMP discovery root, re-asserted here so a future refactor cannot quietly relocate the store into one.",
            "A malformed definition reports its file path and does not abort the whole listing.",
            "A missing or empty store directory yields an empty listing, not an error.",
            "Both shipped examples parse through `parsePeerDefinition` in the suite, so a schema change cannot leave the documentation lying.",
            "Lookup by name returns the shadowing definition.",
        ],
        depends_on=["T-101"],
        evidence=[
            ("Peer store with shadowing and error reporting", "src/daemon/peer-store.ts"),
            ("Peer-store suite, 7 tests incl. mutation-proven shadowing", "tests/peer-store.test.ts"),
            ("Shipped examples that parse in the suite", "agents/example-reviewer.md"),
        ],
        out_of_scope=["Materialization, which T-201 already owns."],
    ),
    Task(
        id="T-502", slug="daemon-entry-point", title="Daemon entry point",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="`omp-agent daemon` boots every subsystem, serves the control protocol, and keeps running after its terminal closes.",
        read_first=[
            ARCH,
            ("Broker hosting", "src/daemon/boot.ts"),
            ("Supervisor", "src/daemon/supervisor.ts"),
            ("Control protocol", "docs/delivery/tasks/T-507-control-socket-protocol.md"),
            ("ADR-001: RPC subprocess workers", "docs/delivery/adr/ADR-001-rpc-subprocess-workers.md"),
        ],
        files=["src/daemon/main.ts", "src/daemon/socket.ts", "package.json", "tests/daemon-main.test.ts"],
        assets=[
            ("src/daemon/main.ts", "New", "Composition root."),
            ("src/daemon/socket.ts", "New", "Serves the T-507 protocol over a unix socket."),
            ("tests/daemon-main.test.ts", "New", "Boot, socket, single-instance, shutdown."),
            ("src/shared/protocol.ts", "Read", "The method set and version this server implements."),
            ("src/daemon/boot.ts", "Read", "`resolveBrokerHosting` already exists."),
            ("src/daemon/credential-gateway.ts", "Read", "Started here."),
            ("src/daemon/supervisor.ts", "Read", "Started here."),
            ("package.json", "Edited", "Adds the `bin` entry."),
        ],
        steps=[
            "Compose boot order: resolve broker hosting, start the gateway, open the room store, construct the scheduler, registry, and supervisor.",
            "Register peers from the store and arm their schedules.",
            "Serve the T-507 protocol on a unix socket: `status`, `chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`, `rooms_list`, `rooms_post`, `schedules_list`, `schedules_arm`, `kill`, and `bump`. Dispatch through the shared schemas rather than hand-parsing each payload.",
            "Write a pidfile beside the socket under the active agent dir, honoring `PI_CODING_AGENT_DIR`.",
            "Detach from the controlling TTY, since surviving a closed terminal is the product's core claim.",
            "Shut down in reverse order so a stop does not strand a parked watcher or leave a half-swapped worker dir.",
        ],
        acceptance=[
            "The daemon starts, serves its socket, and answers a status request.",
            "It serves every method T-507 declares, or answers method-not-found carrying the protocol version.",
            "It keeps running after its launching terminal exits.",
            "A second instance for the same profile refuses to start rather than corrupting shared state.",
            "Shutdown closes the gateway, stops workers, and removes the pidfile.",
            "Boot honors `PI_CODING_AGENT_DIR` for socket and pidfile placement.",
        ],
        depends_on=["T-501", "T-507"],
        evidence=[
            ("Daemon suite, 29 tests incl. boot/detach/shutdown", "tests/daemon-main.test.ts"),
            ("Composition root", "src/daemon/main.ts"),
            ("Thirteen-method socket server", "src/daemon/socket.ts"),
            ("Commit", "c99c961"),
        ],
        out_of_scope=[
            "TUI rendering, which is T-504.",
            "Persisting agents, runs, and schedules, which is T-508.",
        ],
    ),
    Task(
        id="T-508", slug="daemon-persistence", title="Daemon persistence and orphan sweep",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="Agents, runs, and schedules survive a daemon restart, and worker directories left by a crash are swept at boot.",
        read_first=[ARCH, ("Daemon entry point", "docs/delivery/tasks/T-502-daemon-entry-point.md"), ("Room store", "src/rooms/store.ts")],
        files=["src/daemon/db.ts", "src/daemon/main.ts", "tests/daemon-persistence.test.ts"],
        assets=[
            ("src/daemon/db.ts", "New", "`agents`, `runs`, `schedules` tables and their accessors."),
            ("src/daemon/main.ts", "Edited", "Opens the database and runs the sweep during boot."),
            ("tests/daemon-persistence.test.ts", "New", "Restart survival, run records, sweep."),
            ("src/rooms/store.ts", "Read", "The existing SQLite conventions to follow, not a second style."),
            ("src/daemon/materializer.ts", "Read", "Owns the `workers/` layout the sweep cleans up."),
        ],
        steps=[
            "Add `agents`, `runs`, and `schedules` tables, following the room store's existing SQLite conventions rather than introducing a second persistence style in the same process.",
            "Write one run record per delivered turn: which peer, which trigger, what outcome. Without it a restart erases the only evidence of what the system did while nobody was watching, which is precisely the period this product exists to cover.",
            "Restore registered agents and armed schedules from the database at boot, so an unattended restart resumes rather than starting empty.",
            "Sweep orphaned `workers/` materialized directories at startup by comparing them against the persisted registry. This is why the task follows T-502: the sweep needs a registry that outlives the crash, and a sweep with no registry either deletes live state or nothing.",
            "Make the sweep conservative and loud: report what it removed. A silent deleter of directories is not something to debug at 3am.",
        ],
        acceptance=[
            "Agents, runs, and schedules reload after a daemon restart.",
            "Every delivered turn leaves exactly one run record naming its trigger and outcome.",
            "A `workers/` directory with no registry entry is removed at boot and reported.",
            "A `workers/` directory that does have a registry entry is left alone.",
            "The sweep is proven non-vacuous: with the sweep reverted, the orphan test fails.",
        ],
        depends_on=["T-502"],
        evidence=[
            ("Persistence store", "src/daemon/db.ts"),
            ("Persistence suite, 15 tests incl. restart and interrupted-run cases", "tests/daemon-persistence.test.ts"),
        ],
        out_of_scope=[
            "Transcript storage; §10 resolves that as OMP's own JSONL plus a cursor, not a duplicate message store.",
            "Room, message, and subscription tables, which T-402 owns.",
        ],
    ),
    Task(
        id="T-503", slug="agent-toolbelt", title="Worker toolbelt extension",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="A worker can talk to rooms and peers through tools injected into its own session.",
        read_first=[
            ARCH,
            ("Room store", "src/rooms/store.ts"),
            ("Spawn classification", "src/worker/lifecycle.ts"),
            ("Control protocol", "docs/delivery/tasks/T-507-control-socket-protocol.md"),
        ],
        files=["src/worker/toolbelt.ts", "tests/toolbelt.test.ts"],
        assets=[
            ("src/worker/toolbelt.ts", "New", "`chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`."),
            ("tests/toolbelt.test.ts", "New", "Tool behavior against a running daemon socket."),
            ("src/shared/protocol.ts", "Read", "The method set these tools call; do not invent a second one."),
            ("src/rooms/store.ts", "Read", "Backing bus."),
            ("src/worker/lifecycle.ts", "Read", "`classifyAgentSpawn` already exists; reuse it."),
            ("src/daemon/socket.ts", "Read", "Transport to the daemon."),
        ],
        steps=[
            "Expose the toolbelt as an OMP extension loaded into each worker session.",
            "Route every call over the daemon control socket using the T-507 client types, so the worker never touches the room database directly and cannot corrupt a shared writer.",
            "Implement `chat_wait` as a blocking wait the daemon satisfies on a wake, rather than a poll loop that burns turns. What counts as a wake is T-509's semantics: a mention the peer opted into, or a post in a room it subscribes to, never its own post.",
            "Route `agent_spawn` through `classifyAgentSpawn` and reject a coding subtask with a message naming `task` as the correct tool.",
            "Keep the tool list additive: never emit an explicit `tools:` list that would strip native `task`.",
        ],
        acceptance=[
            "`chat_send` posts and the message is visible to a subscribed peer.",
            "`chat_wait` blocks and returns on a wake as T-509 defines it, and does not return on a post the peer would not be woken by.",
            "`agent_spawn` with a coding-subtask payload is refused and names `task`.",
            "A worker with the toolbelt still exposes native `task` in its effective tool list.",
            "Every call goes over the socket: the suite fails if the toolbelt opens the room database itself.",
        ],
        depends_on=["T-502", "T-507"],
        out_of_scope=[
            "New room semantics; T-402 owns the store.",
            "Wake filtering itself, which T-509 implements in the supervisor.",
        ],
        evidence=[
            ("Toolbelt extension, six tools over the T-507 socket", "src/worker/toolbelt.ts"),
            ("Toolbelt suite incl. a real OMP child round trip", "tests/toolbelt.test.ts"),
        ],
    ),
    Task(
        id="T-504", slug="tui-surface", title="TUI commands, status widget, and dialogs",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="A human can see and steer running agents from inside the OMP TUI.",
        read_first=[
            ARCH,
            ("Extension stub", "src/extension/index.ts"),
            ("Control protocol", "docs/delivery/tasks/T-507-control-socket-protocol.md"),
            ("ADR-005: sandbox opt-in, fail closed", "docs/delivery/adr/ADR-005-sandbox-opt-in-fail-closed.md"),
        ],
        files=["src/extension/index.ts", "src/extension/commands.ts", "src/extension/widget.ts", "tests/extension.test.ts"],
        assets=[
            ("src/extension/index.ts", "Edited", "Currently a no-op factory."),
            ("src/extension/commands.ts", "New", "`/agents`, `/rooms`, `/schedule`, `/spawn`, `/kill`. Steering verbs (`/logs`, `/inject`) are T-511, which owns the protocol additions they need."),
            ("src/extension/widget.ts", "New", "Status line."),
            ("tests/extension.test.ts", "New", "Command output and no-daemon degradation."),
            ("src/shared/protocol.ts", "Read", "The methods the commands call."),
            ("src/daemon/socket.ts", "Read", "Data source."),
        ],
        steps=[
            "Implement `/agents` listing name, state, account, and room subscriptions.",
            "Show a shield only for peers actually running under an OS sandbox, never for `workspace:` scoping, because a shield on an unsandboxed agent is a false security claim.",
            "Implement `/rooms` to read a transcript and post as `@you`.",
            "Implement `/schedule` to list and arm schedules.",
            "Implement `/spawn` to start a peer from a definition. Steering verbs (`/logs --tail`, inject-instructions) need protocol methods T-507 froze without them; T-511 owns the protocol additions and the verbs together.",
            "Add a status widget with running and parked counts plus unread totals.",
            "Use ask-dialogs for destructive actions: killing a worker, bumping a metered budget.",
            "Degrade to a clear message when no daemon is running, rather than throwing inside the TUI.",
        ],
        acceptance=[
            "`/agents` lists peers with live state from the daemon.",
            "The shield appears only for sandboxed peers, verified against one sandboxed and one unsandboxed agent.",
            "`/rooms` posts as `@you` and the message wakes a subscribed peer.",
            "`/spawn` starts a peer that then appears in `/agents`. (Steering — `/logs --tail` and injected instructions reaching the live session's next turn — is T-511's acceptance, gated on its protocol additions.)",
            "Killing a worker asks for confirmation first.",
            "With no daemon running, every command reports that clearly instead of raising.",
        ],
        depends_on=["T-502", "T-507"],
        evidence=[
            ("Command and widget surface", "src/extension/commands.ts"),
            ("Extension suite, 16 tests over the real socket", "tests/extension.test.ts"),
        ],
        out_of_scope=["Bus semantics and worker lifecycle, already covered by EP-04."],
    ),
    Task(
        id="T-511", slug="operator-steering", title="Operator steering: logs tail and instruction injection",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="`/logs --tail` follows a running worker's output and an injected instruction reaches a live session's next turn — the steering half of the TUI that T-504 deferred because the protocol had no methods for it.",
        read_first=[
            ARCH,
            ("Control protocol", "src/shared/protocol.ts"),
            ("Socket server", "src/daemon/socket.ts"),
            ("TUI commands", "src/extension/commands.ts"),
        ],
        files=[
            "src/shared/protocol.ts",
            "src/shared/protocol-schemas.ts",
            "src/daemon/socket.ts",
            "src/extension/commands.ts",
            "tests/protocol.contract.test.ts",
            "tests/extension.test.ts",
            "tests/daemon-main.test.ts",
        ],
        assets=[
            ("src/shared/protocol.ts", "Edited", "Adds `logs_tail` and `inject` method shapes."),
            ("src/shared/protocol-schemas.ts", "Edited", "Validators for both, on params and results."),
            ("src/daemon/socket.ts", "Edited", "Serves both methods against live workers."),
            ("src/extension/commands.ts", "Edited", "The `/logs` and `/inject` verbs."),
            ("tests/protocol.contract.test.ts", "Edited", "The method set grows; the exact-set test must name the new methods."),
            ("tests/extension.test.ts", "Edited", "Verb coverage over the real socket."),
            ("tests/daemon-main.test.ts", "Edited", "Method coverage against a stub worker."),
        ],
        steps=[
            "Add the methods additively without bumping `protocolVersion`: an old daemon answers an unknown method with method-not-found carrying its version, which is the designed mismatch path, so additive growth does not need lockstep. Record that policy in the protocol module's header so the next addition follows it.",
            "`logs_tail` params `{name, lines?}` return `{name, lines: string[]}` from the worker's buffered stderr/stdout (WorkerHandle exposes `stderr()`; size the buffer in the daemon, not per request).",
            "`inject` params `{name, message}` queue the message into the worker's next turn — through `Supervisor.deliver` if the peer is parked, directly via `worker.prompt` when running — and return `{name, queued: boolean}`.",
            "Wire both verbs in the TUI: `/logs <name> [--tail]` prints the buffer (tail follows), `/inject <name> <message>` confirms the queue.",
            "Update the contract suite's exact method set and add validation fixtures for both methods, params and results.",
        ],
        acceptance=[
            "An old client calling `logs_tail` against this daemon gets a validated result; this daemon calling an unknown method still answers method-not-found with the version.",
            "`/logs --tail` against a running stub worker streams its output in the extension suite.",
            "An injected instruction reaches the worker's next prompt, proven against the daemon suite's stub worker prompts.",
            "The protocol header documents the additive-no-bump policy.",
        ],
        depends_on=["T-502", "T-504"],
        evidence=[
            ("Seventeen-method protocol with steering shapes", "src/shared/protocol.ts"),
            ("Steering verbs registered in the TUI", "src/extension/index.ts"),
            ("Extension suite covers /logs and /inject over the real socket", "tests/extension.test.ts"),
        ],
        out_of_scope=[
            "Streaming logs over a subscription (a method per call is enough at this size; SSE/websocket tailing belongs to the console API, T-602).",
        ],
    ),
    Task(
        id="T-512", slug="sandboxed-on-the-wire", title="Surface sandboxed state in agent_status",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="The daemon reports which peers actually run under an OS sandbox, so the TUI shield (T-504, fail-closed) can ever appear.",
        read_first=[
            ARCH,
            ("Protocol types", "src/shared/protocol.ts"),
            ("Socket server", "src/daemon/socket.ts"),
            ("ADR-005: sandbox opt-in, fail closed", "docs/delivery/adr/ADR-005-sandbox-opt-in-fail-closed.md"),
        ],
        files=[
            "src/shared/protocol.ts",
            "src/shared/protocol-schemas.ts",
            "src/daemon/socket.ts",
            "tests/daemon-main.test.ts",
        ],
        assets=[
            ("src/shared/protocol.ts", "Edited", "`AgentStatus.sandboxed?: boolean` — optional, additive, no version bump (T-511's policy)."),
            ("src/shared/protocol-schemas.ts", "Edited", "Accept the optional boolean."),
            ("src/daemon/socket.ts", "Edited", "`toAgentStatus` emits it from `WorkerHandle.sandboxed`."),
            ("tests/daemon-main.test.ts", "Edited", "One sandboxed and one unsandboxed peer, asserted on the wire."),
        ],
        steps=[
            "Add the optional field to the type and the validators; an absent field must remain valid, because older workers predate it.",
            "Emit `WorkerHandle.sandboxed` (it already exists on the handle) in the daemon's status mapping — never infer it from `workspace:` scoping, which is not a sandbox (ADR-005).",
            "Assert one sandboxed and one unsandboxed peer over the real socket in the daemon suite.",
        ],
        acceptance=[
            "A sandboxed peer's status arrives with `sandboxed: true`; an unsandboxed peer arrives without it or with `false`.",
            "The protocol suite accepts both shapes.",
            "The extension's shield test (already landed) needs no change to pass against the production server.",
        ],
        depends_on=["T-502"],
        evidence=[
            ("Optional sandboxed flag in the wire type and validators", "src/shared/protocol.ts"),
            ("Daemon status mapping emits it from the worker handle", "src/daemon/socket.ts"),
        ],
        out_of_scope=["Changing which peers are sandboxed — that is definition-level (`sandbox: true`), already shipped in EP-02."],
    ),
    Task(
        id="T-513", slug="reaction-methods-on-the-socket", title="Reaction methods on the control socket",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="The daemon serves `chat_react` and `chat_unreact`, so the T-604 toolbelt works in production instead of returning method-not-found.",
        read_first=[
            ARCH,
            ("Control protocol", "src/shared/protocol.ts"),
            ("Socket server", "src/daemon/socket.ts"),
            ("Toolbelt", "src/worker/toolbelt.ts"),
            ("ADR-009: threads and reactions", "docs/delivery/adr/ADR-009-threads-and-reactions.md"),
        ],
        files=[
            "src/shared/protocol.ts",
            "src/shared/protocol-schemas.ts",
            "src/daemon/socket.ts",
            "tests/protocol.contract.test.ts",
            "tests/daemon-main.test.ts",
            "tests/toolbelt.test.ts",
        ],
        assets=[
            ("src/shared/protocol.ts", "Edited", "Adds `chat_react`/`chat_unreact`; wire RoomMessage gains the T-601 fields (parentId, threadRootId, replyCount, reactions) as optional, additive, no version bump (T-511's policy)."),
            ("src/shared/protocol-schemas.ts", "Edited", "Validators for both methods and the widened message shape."),
            ("src/daemon/socket.ts", "Edited", "Serves both methods through `RoomStore.react`/`unreact`; reactions ride chat_read/chat_wait results."),
            ("tests/protocol.contract.test.ts", "Edited", "The method set grows from thirteen; fixtures for both new methods."),
            ("tests/daemon-main.test.ts", "Edited", "A react over the socket lands in the store and in chat_read output."),
            ("tests/toolbelt.test.ts", "Edited", "The fake-backed reaction tests migrate to the production handlers."),
        ],
        steps=[
            "Follow the additive-no-bump policy already documented for T-511: new methods and optional result fields, no version change.",
            "Serve react/unreact in the daemon by delegating to the store; the allowed-set refusal stays a toolbelt-local concern, and the daemon accepts what the store accepts.",
            "Widen the wire RoomMessage so chat_read and chat_wait return the conversation model T-601 built; without it a reacting agent is invisible to every socket reader.",
            "Migrate the toolbelt's reaction tests from the test-only backing to the production socket handlers, per ADR-008.",
        ],
        acceptance=[
            "A toolbelt chat_react call against the real daemon lands on the message and is visible in chat_read.",
            "chat_unreact removes it; reacting twice leaves one reaction.",
            "The protocol contract suite names both methods in its exact set.",
            "The T-604 acceptance items pass against the production socket, which is what flips T-604 to Done.",
        ],
        depends_on=["T-507", "T-604"],
        evidence=[
            ("Fifteen-method protocol with reaction shapes", "src/shared/protocol.ts"),
            ("Daemon serves both methods through the store", "src/daemon/socket.ts"),
        ],
        out_of_scope=["Streaming reactions to the console; T-602's live feed already covers browser readers."],
    ),
    Task(
        id="T-505", slug="definition-staleness", title="Rebuild a worker when its definition changes",
        epic="EP-05", sprint="SP-05", status="Done",
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
            ("tests/supervisor.test.ts", "Edited", "Staleness cases; T-405 owns the file."),
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
        evidence=[
            ("Fingerprint-checked delivery and respawn seam", "src/daemon/supervisor.ts"),
            ("Staleness cases in the supervisor suite plus a daemon-level rebuild test", "tests/supervisor.test.ts"),
        ],
    ),
    Task(
        id="T-506", slug="metered-budget-wiring", title="Wire metered budget warnings into rooms",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="A metered account's 80% warning reaches a human where they will see it.",
        read_first=[ARCH, ("Registry", "src/daemon/account-registry.ts"), ("Supervisor", "src/daemon/supervisor.ts")],
        files=["src/daemon/supervisor.ts", "tests/supervisor.test.ts"],
        assets=[
            ("src/daemon/supervisor.ts", "Edited", "`onWarning` is currently an empty callback."),
            ("tests/supervisor.test.ts", "Edited", "Warning and bump cases; T-405 owns the file."),
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
        evidence=[
            ("Warnings and park/bump messages post through the supervisor", "src/daemon/supervisor.ts"),
            ("Supervisor suite: warn-once, park-at-cap, bump-resumes, re-cross cases", "tests/supervisor.test.ts"),
        ],
        out_of_scope=["Subscription accounts, which never take this path."],
    ),
    Task(
        id="T-509", slug="wake-filters", title="Wake filters and mention parsing",
        epic="EP-05", sprint="SP-05", status="Done",
        goal="The parsed `wake:` configuration actually governs who a message wakes.",
        read_first=[ARCH, ("Supervisor", "src/daemon/supervisor.ts"), ("Parser", "src/shared/agent-definition.ts")],
        files=["src/daemon/supervisor.ts", "src/rooms/store.ts", "tests/supervisor.test.ts"],
        assets=[
            ("src/daemon/supervisor.ts", "Edited", "Consume `wake.mention` and `wake.rooms` in the delivery path."),
            ("src/rooms/store.ts", "Edited", "Expose mentions alongside message text so delivery does not re-parse bodies."),
            ("tests/supervisor.test.ts", "Edited", "Mention and subscription wake cases; T-405 owns the file."),
            ("src/shared/agent-definition.ts", "Read", "`wake: {mention, rooms}` already parses; nothing reads it yet."),
        ],
        steps=[
            "Consume the already-parsed `wake: {mention, rooms}` in delivery. The parser has produced this since T-101 and nothing has ever read it, which means a documented, validated, tested configuration key currently does nothing at all.",
            "Parse `@name` mentions once, at post time, and carry them with the message rather than re-scanning every body per subscriber on every delivery.",
            "Wake a peer on a mention only when its `wake.mention` is true, so opting out is real rather than advisory.",
            "Wake on a room post only for peers subscribed to that room, which is existing behavior and must stay: keep it as a regression test rather than reimplementing it.",
            "Never wake a peer on its own post. This is already covered and stays covered; the test moves under this task's ownership rather than being written twice.",
        ],
        acceptance=[
            "`@name` in a body wakes that peer when `wake.mention` is true, and does not when it is false.",
            "A room post wakes only that room's subscribers.",
            "A peer's own post never wakes it, proven by the existing regression continuing to pass.",
            "A mention of an unknown name wakes nobody and is not an error.",
            "Mentions are parsed once per post, not once per subscriber, asserted by the parse being observable exactly once.",
        ],
        depends_on=["T-405"],
        evidence=[
            ("Wake-filtered delivery in the supervisor", "src/daemon/supervisor.ts"),
            ("Supervisor suite: mention, opt-out, own-post, and parse-once cases", "tests/supervisor.test.ts"),
        ],
        out_of_scope=[
            "Reaction-based wakes; ADR-009 keeps a reaction from marking anything read.",
            "The toolbelt's `chat_wait`, which consumes these semantics but is T-503.",
        ],
    ),
]

TASKS += [
    # ── EP-06: web console ───────────────────────────────────────────────────
    Task(
        id="T-601", slug="conversation-model", title="Threads, replies, and reactions in the store",
        epic="EP-06", sprint="SP-06", status="Done",
        goal="A message can reply to another, threads have roots, and any participant can react to a message.",
        read_first=[ARCH, ("Room store", "src/rooms/store.ts"), ("Room suite", "tests/rooms.test.ts")],
        files=["src/rooms/store.ts", "tests/rooms.test.ts"],
        assets=[
            ("src/rooms/store.ts", "Edited", "Schema and API for replies and reactions."),
            ("tests/rooms.test.ts", "Edited", "Covers the new shapes."),
            ("src/daemon/supervisor.ts", "Read", "Delivery semantics must not change."),
        ],
        steps=[
            "Add `parent_id` to `messages`, nullable, referencing another message in the same room.",
            "Derive a thread root rather than storing a second pointer, so a reply to a reply cannot disagree with its own thread about where it belongs.",
            "Add a `reactions` table keyed by `(message_id, actor, emoji)` with a uniqueness constraint: a participant reacting twice with the same emoji is one reaction, not two.",
            "Extend `listMessages` to return reply counts and reactions in one read, so the UI renders a channel in a single round trip.",
            "Leave `pendingForAgent` semantics alone. A threaded reply is still an unread message, and changing wake behavior here would silently alter every existing peer.",
            "Add idempotent `react(messageId, actor, emoji)` and `unreact(...)`.",
        ],
        acceptance=[
            "A reply carries its parent, and its thread root resolves to the top of the chain.",
            "Reacting twice with the same emoji leaves one reaction.",
            "Removing a reaction that was never added is a no-op, not an error.",
            "`listMessages` returns reply counts and reactions without a second query.",
            "Existing wake and unread behavior is unchanged, proven by the current room suite passing untouched.",
        ],
        out_of_scope=[
            "Any HTTP surface; T-602 owns that.",
            "Schema migration for existing room databases. Nothing is deployed yet, so a migration path would be maintenance for a population of zero; the store is recreated instead.",
        ],
        evidence=[
            ("Threaded store with derived roots and aggregated reactions", "src/rooms/store.ts"),
            ("Room suite with non-vacuous conversation coverage", "tests/rooms.test.ts"),
            ("Commit", "2563a0e"),
        ],
    ),
    Task(
        id="T-602", slug="console-api", title="Daemon HTTP and WebSocket API",
        epic="EP-06", sprint="SP-07", status="Done",
        goal="A browser can read and change agents, channels, and messages over HTTP, and receive live updates.",
        read_first=[ARCH, ("Daemon entry point", "docs/delivery/tasks/T-502-daemon-entry-point.md"), ("Conversation model", "docs/delivery/tasks/T-601-conversation-model.md")],
        files=["src/daemon/console-api.ts", "tests/console-api.test.ts"],
        assets=[
            ("src/daemon/console-api.ts", "New", "HTTP and WebSocket surface."),
            ("tests/console-api.test.ts", "New", "Route, wake, and socket cases."),
            ("src/rooms/store.ts", "Read", "Backing state."),
            ("src/daemon/supervisor.ts", "Read", "Posting must route through it."),
        ],
        steps=[
            "Serve on loopback by default, beside the daemon's other listeners.",
            "Expose read routes for agents, channels, and messages, plus writes for creating a channel and posting a message.",
            "Route every post through `Supervisor.post()` rather than `RoomStore.post()`. The supervisor is what wakes subscribers; writing straight to the store would leave agents silent.",
            "Add a WebSocket that pushes new messages and reactions so an open browser does not poll.",
            "Refuse a write whose author is an agent name: the console posts as the human, and forging an agent identity would make a transcript untrustworthy.",
        ],
        acceptance=[
            "Creating a channel over HTTP makes it visible to a worker.",
            "Posting over HTTP wakes a subscribed peer exactly as a supervisor post does.",
            "A connected WebSocket receives a message posted by an agent.",
            "A write claiming an agent as author is refused.",
            "The server binds loopback and refuses a request with no operator token.",
        ],
        out_of_scope=["The browser client; T-603 owns it."],
        evidence=[
            ("Token-gated console server with live feed", "src/daemon/console-api.ts"),
            ("Console API suite, 22 tests with a ten-mutation non-vacuity matrix", "tests/console-api.test.ts"),
        ],
        depends_on=["T-502", "T-601"],
    ),
    Task(
        id="T-603", slug="console-client", title="Browser client",
        epic="EP-06", sprint="SP-07", status="Done",
        goal="A human can watch and join agent conversations in a browser.",
        read_first=[ARCH, ("Console API", "docs/delivery/tasks/T-602-console-api.md"), ("ADR-009: threads and reactions", "docs/delivery/adr/ADR-009-threads-and-reactions.md")],
        files=["src/console/index.html", "src/console/app.js", "src/console/style.css", "tests/console-client.test.ts"],
        assets=[
            ("src/console/app.js", "New", "Client logic. Plain JS with JSDoc types: browsers do not parse TS annotations and there is no build step."),
            ("src/console/index.html", "New", "Shell."),
            ("src/console/style.css", "New", "Styling."),
            ("tests/console-client.test.ts", "New", "Drives a real browser against a running daemon."),
            ("src/daemon/console-api.ts", "Read", "The API it consumes."),
        ],
        steps=[
            "Render a channel list, a transcript, and a composer.",
            "Open a thread in a side pane rather than inline, so a long thread cannot push the channel out of view.",
            "Show reactions under a message with counts; a click toggles the operator's own.",
            "Reconnect the WebSocket on drop and refetch. A socket dropped during a long agent turn would otherwise leave a permanently stale transcript.",
            "Keep it dependency-free unless a real need appears: the surface is small and a framework would outweigh it.",
        ],
        acceptance=[
            "Channels, messages, and reactions render from a live daemon.",
            "A message sent from the browser appears in the transcript and reaches a subscribed agent.",
            "A reply opens in the thread pane and does not appear at the channel root.",
            "Dropping and restoring the connection restores a correct transcript.",
            "Verified by driving a real browser against a running daemon, not by asserting on rendered strings alone.",
            "Closing the browser stops and parks nothing: with the tab shut, a scheduled run still fires and a room post still wakes its subscribers. The console is a viewer, and a viewer that can halt the system by being closed is not one.",
        ],
        out_of_scope=["Creation forms; T-605 owns those."],
        evidence=[
            ("Dependency-free three-pane client", "src/console/app.js"),
            ("Browser-driven suite, 7 tests against a real daemon and headless Chrome", "tests/console-client.test.ts"),
        ],
        depends_on=["T-602"],
    ),
    Task(
        id="T-604", slug="reaction-toolbelt", title="Agents set reactions as status",
        epic="EP-06", sprint="SP-07", status="Done",
        goal="An agent can mark a message with an emoji to signal what it is doing about it.",
        read_first=[
            ARCH,
            ("Toolbelt", "docs/delivery/tasks/T-503-agent-toolbelt.md"),
            ("Conversation model", "docs/delivery/tasks/T-601-conversation-model.md"),
            ("ADR-009: threads and reactions", "docs/delivery/adr/ADR-009-threads-and-reactions.md"),
        ],
        files=["src/worker/toolbelt.ts", "tests/toolbelt.test.ts"],
        assets=[
            ("src/worker/toolbelt.ts", "Edited", "Adds `chat_react`."),
            ("tests/toolbelt.test.ts", "Edited", "Reaction cases beside T-503's chat cases."),
            ("src/rooms/store.ts", "Read", "`react` and `unreact` exist after T-601."),
        ],
        steps=[
            "Add `chat_react(messageId, emoji)` and its removal counterpart to the toolbelt.",
            "State the convention in the tool description: mark a message picked up, finished, or failed, so a human scanning a channel sees state without reading every turn.",
            "Reject an emoji outside a small declared set. A free-form vocabulary cannot be rendered as status in the UI.",
            "Route through the daemon socket like every other toolbelt call, never touching the database directly.",
        ],
        acceptance=[
            "An agent's reaction appears on the message for every reader.",
            "An unknown emoji is refused with a message naming the allowed set.",
            "Reacting twice is idempotent.",
            "A reaction does not mark the message read or suppress a wake.",
        ],
        depends_on=["T-503", "T-601"],
        evidence=[
            ("Reaction tools with the ADR-009 status vocabulary", "src/worker/toolbelt.ts"),
            ("Toolbelt suite drives the production socket handlers", "tests/toolbelt.test.ts"),
        ],
    ),
    Task(
        id="T-605", slug="console-management", title="Create agents and channels from the UI",
        epic="EP-06", sprint="SP-07", status="Done",
        goal="An operator can stand up an agent or channel, and manage membership, without editing files.",
        read_first=[
            ARCH,
            ("Peer store", "docs/delivery/tasks/T-501-peer-store.md"),
            ("Console client", "docs/delivery/tasks/T-603-console-client.md"),
            ("Definition staleness", "docs/delivery/tasks/T-505-definition-staleness.md"),
            ("Supervisor room filtering", "src/daemon/supervisor.ts"),
        ],
        files=[
            "src/console/app.js",
            "src/daemon/console-api.ts",
            "src/daemon/peer-store.ts",
            "src/daemon/supervisor.ts",
        ],
        assets=[
            ("src/console/app.js", "Edited", "Forms and membership controls (the client is plain JS; T-603)."),
            ("src/daemon/console-api.ts", "Edited", "Write routes, including the reaction-toggle route the T-603 client already calls."),
            ("src/daemon/peer-store.ts", "Edited", "Writing a definition, not only reading one."),
            ("src/daemon/supervisor.ts", "Edited", "Live membership: the running peer's cached room set."),
            ("src/rooms/store.ts", "Read", "Durable subscriptions; T-402 owns it."),
        ],
        steps=[
            "Write a created agent as a definition file in the private store, so the UI and a hand-written file produce the same thing and neither becomes a second source of truth.",
            "Validate through `parsePeerDefinition` before writing, and surface the parse error in the form rather than writing a file the daemon will later refuse.",
            "Let an operator add or remove an agent from a channel, updating both the durable subscription and the definition.",
            "Apply the change to the *running* peer, not only to disk. `Supervisor.register` copies rooms into a private `Set` and `post()` filters against that copy, so a membership edit that stops at SQLite leaves a live agent deaf to its new channel and still woken by its old one.",
            "Expose that as a single supervisor operation which re-reads membership and re-registers the peer, rather than letting the API mutate a private field: two writers to the same cached set is the defect this task exists to avoid.",
            "Reuse T-505's fingerprint check for definition edits. Membership alone needs no rebuild, but any other change does, and a live worker's policy files never mutate under a running process.",
            "Say plainly in the UI which changes took effect immediately and which need a rebuild.",
        ],
        acceptance=[
            "An agent created in the UI appears as a definition file and loads on the next daemon start.",
            "An invalid definition is refused with the parser's own error, and no file is written.",
            "Adding a *running* agent to a channel makes it receive the very next message there, with no restart.",
            "Removing a running agent stops delivery on the next post, and does not disturb the channel's other members.",
            "A definition edit that changes policy is reported as needing a rebuild rather than silently applied to a live worker.",
            "The membership tests drive `Supervisor.post()`, not `RoomStore.post()`, since only the supervisor path proves a live peer was actually woken.",
        ],
        depends_on=["T-501", "T-505", "T-603"],
        evidence=[
            ("Management routes with hardened write path", "src/daemon/console-api.ts"),
            ("Store writes: safe names, path-keyed conflicts, atomic landings", "src/daemon/peer-store.ts"),
            ("Console suites, API and browser, cover forms and membership", "tests/console-api.test.ts"),
        ],
    ),
]

TASKS += [
    # ── EP-07: release readiness ─────────────────────────────────────────────
    Task(
        id="T-701", slug="ci-workflow", title="CI: typecheck, test, and delivery-doc drift",
        epic="EP-07", sprint="SP-08", status="Done",
        goal="A push proves the tree type-checks, the suite passes, and the delivery docs match their generator.",
        read_first=[ARCH, ("Delivery generator", "scripts/gen-delivery-docs.py"), ("Delivery tree contract", "docs/delivery/README.md")],
        files=[".github/workflows/ci.yml"],
        assets=[
            (".github/workflows/ci.yml", "New", "Install, typecheck, test, lint, docs-drift."),
            ("package.json", "Read", "Supplies the `typecheck` and `test` scripts CI invokes."),
            ("scripts/gen-delivery-docs.py", "Read", "Re-run in CI; its output must match what is committed."),
        ],
        steps=[
            "Run on push and pull request, on a single `ubuntu-latest` runner with `oven-sh/setup-bun`; there is no per-OS behavior in the suite worth a matrix's cost.",
            "`bun install --frozen-lockfile`, so a drifted lockfile fails here rather than surprising the next developer.",
            "Run `tsc --noEmit`, then `bun test`. Keep them separate steps: a type error and a failing assertion are different problems and should not share a red X.",
            "Run `bunx biome check .` so style failures fail the build beside behavioral ones.",
            "Regenerate the delivery tree with `python3 scripts/gen-delivery-docs.py` and fail on any diff under `docs/delivery/`. A generated tree nobody re-generates is a hand-maintained tree with extra steps.",
            "Do not cache aggressively: `bun install` on this dependency set is cheap, and a stale cache that hides a resolution failure costs more than it saves.",
        ],
        acceptance=[
            "A push runs install, typecheck, and test, and a failure in any one fails the build.",
            "Committing a hand-edit to `docs/delivery/` fails CI with the diff shown.",
            "Regenerating and committing that same edit's source in the generator makes CI green again.",
            "The workflow is verified by pushing it, not by reading it: a workflow that has never run is a guess.",
        ],
        evidence=[
            ("Workflow file", ".github/workflows/ci.yml"),
            ("First push green: install, typecheck, test, lint, docs-drift (run 33134780907, 48s)", "https://github.com/bloodf/oh-my-agent/actions"),
        ],
        out_of_scope=[
            "Publishing, tagging, and release automation.",
        ],
    ),
    Task(
        id="T-702", slug="biome-lint", title="Biome lint and format configuration",
        epic="EP-07", sprint="SP-08", status="Done",
        goal="The repository has one enforced style, checkable in one command.",
        read_first=[ARCH, ("Package manifest", "package.json")],
        files=["biome.json", "package.json"],
        assets=[
            ("biome.json", "New", "Lint and format rules."),
            ("package.json", "Edited", "Adds `lint` and `format` scripts."),
        ],
        steps=[
            "Configure Biome for the TypeScript sources and the test tree, excluding `node_modules` and any generated output.",
            "Add `lint` (check, no writes) and `format` (write) scripts, so CI and a developer run the same tool with different intent rather than two tools.",
            "Run the one-time normalization as its own separate change, before or after this one but never inside it: a formatting sweep mixed into a config commit makes both unreviewable.",
            "Keep the rule set close to Biome's recommended defaults. A bespoke rule set is a standing argument, and the value here is uniformity, not opinion.",
        ],
        acceptance=[
            "`bun run lint` exits non-zero on a deliberately misformatted file and zero on the normalized tree.",
            "`bun run format` is idempotent: running it twice produces no second diff.",
            "The config excludes generated and vendored paths, so a clean tree is genuinely clean.",
        ],
        evidence=[
            ("Biome configuration", "./biome.json"),
            ("Lint and format scripts", "./package.json"),
        ],
        out_of_scope=[
            "Changing rule severities: the baseline keeps Biome's recommended preset, with one documented suppression (the NUL-matching sandbox regex).",
        ],
    ),
    Task(
        id="T-703", slug="root-readme-and-metadata", title="Root README and package metadata",
        epic="EP-07", sprint="SP-08", status="Done",
        goal="A stranger landing on the repository can tell what it is, install it, and find the delivery tree.",
        read_first=[ARCH, ("Delivery tree", "docs/delivery/README.md"), ("License decision", "docs/delivery/adr/ADR-010-mit-license.md")],
        files=["README.md", "package.json", "LICENSE"],
        assets=[
            ("README.md", "New", "Front door: what, install, run, where to read next."),
            ("package.json", "Edited", "`repository`, `homepage`, `bugs`, `keywords`, `engines`, `license`."),
            ("LICENSE", "New", "MIT text; lands in the same change as the `license` field (ADR-010)."),
            ("ARCHITECTURE.md", "Read", "The design document the README points at, not duplicates."),
        ],
        steps=[
            "State in the first paragraph what the plugin does and what state it is in. A README that oversells an unfinished operator surface costs more trust than it buys.",
            "Give install and run instructions that were actually executed, not inferred from the manifest.",
            "Link onward: `ARCHITECTURE.md` for the design, `docs/delivery/` for the work. Do not restate either, because a third copy of the same claims is a third thing to keep true.",
            "Add `repository`, `homepage`, `bugs`, `keywords`, and `engines` with `bun >=1.3.14` to the manifest.",
            "Add the MIT `LICENSE` file and `license: \"MIT\"` together, per ADR-010: a field with no text asserts a grant nobody made, and text with no field is invisible to tooling.",
        ],
        acceptance=[
            "The README's install and run commands were run as written and worked.",
            "`package.json` carries repository, homepage, bugs, keywords, and an `engines.bun` constraint.",
            "`package.json` carries `license: \"MIT\"` and the MIT text exists at `LICENSE`, matching ADR-010.",
            "Every link in the README resolves.",
        ],
        evidence=[
            ("Root README", "./README.md"),
            ("Package metadata", "./package.json"),
            ("MIT license text", "./LICENSE"),
        ],
        out_of_scope=[
            "Badges pointing at CI, which are worth adding only once T-701's workflow has run green at least once.",
        ],
    ),
    Task(
        id="T-704", slug="deflake-intermittent-test", title="Identify and fix the intermittent test failure",
        epic="EP-07", sprint="SP-08", status="Done",
        goal="The suite is deterministic: the failure seen once in twelve local runs is named, reproduced, and fixed.",
        read_first=[ARCH, ("Test harness", "tests/harness.test.ts")],
        files=["tests/"],
        assets=[
            ("tests/", "Edited", "Whichever suite the flake lands in; unknown until caught with a full log."),
        ],
        steps=[
            "Catch it with the log kept: `bun test 2>&1 | tee run.log` in a loop, or let CI capture it — the one observed failure (412 total, 1 fail) printed no test name before the shell moved on.",
            "Bias toward the timing-sensitive suites under load: gateway long-polls, scheduler timers, supervisor wake delivery. The single red run happened while the machine was under heavy parallel load; ten unloaded runs were green.",
            "Once named, fix the test's synchronization rather than widening a timeout — a longer timeout is a slower flake, not a smaller one.",
        ],
        acceptance=[
            "The failing test is identified from a captured full log.",
            "Its fix is proven non-vacuous per the working rules.",
            "Ten consecutive full-suite runs pass with the machine under normal load.",
        ],
        evidence=[
            ("Root cause: OMP's legacy-pi compat installs a process-global Bun.plugin onResolve hook that memo-corrupted import.meta.resolve for @oh-my-pi/* — deterministic ordering, not a race", "src/worker/lifecycle.ts"),
            ("Ten consecutive full-suite runs green; resolver shared by both spawn paths and the tests (ADR-008)", "tests/skills.test.ts"),
        ],
        out_of_scope=[
            "Deleting or skipping the flaky test. A skipped test is an admission the behavior is unspecified.",
        ],
    ),
]

TASKS += [
    # ── EP-08: agent hierarchy and authoring ──────────────────────────────────
    Task(
        id="T-801", slug="hierarchy-protocol", title="Hierarchy and authoring protocol",
        epic="EP-08", sprint="SP-09", status="Done",
        goal="The control protocol can create definitions, spawn children, and read and update definitions — additively, no version bump.",
        read_first=[
            ARCH,
            ("Protocol", "src/shared/protocol.ts"),
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
        ],
        files=[
            "src/shared/protocol.ts",
            "src/shared/protocol-schemas.ts",
            "tests/protocol.contract.test.ts",
        ],
        assets=[
            ("src/shared/protocol.ts", "Edited", "New methods `agent_create`, `definition_get`, `definition_update`; `agent_spawn` gains optional `parent`; `AgentStatus` gains optional `parent` and `children`."),
            ("src/shared/protocol-schemas.ts", "Edited", "Validators for every new and widened shape."),
            ("tests/protocol.contract.test.ts", "Edited", "The exact method set grows; fixtures for each addition."),
        ],
        steps=[
            "Add `agent_create` params mirroring the peer-store write fields (`name`, `description`, `model?`, `rooms?`, `wake?`, `autonomy?`, `spawns?`, `body`), result `{name, created: boolean}` — `created:false` when the definition already existed unchanged.",
            "Add `definition_get` `{name}` → the parsed definition plus its source path; `definition_update` `{name, changes}` → `{name, rebuildRequired: boolean}` so a caller learns whether a live worker will rebuild.",
            "Widen `agent_spawn` with optional `parent` (a peer name) and `AgentStatus` with optional `parent?: string` and `children?: string[]`.",
            "Update the contract suite's exact-set test and add valid/invalid fixtures per new shape; the no-bump policy note in the protocol header stays accurate.",
        ],
        acceptance=[
            "Every new method and field validates on params and results, with the offending field named on refusal.",
            "The exact method set in the contract suite matches the implementation.",
            "Older clients remain wire-compatible: every added field is optional.",
        ],
        depends_on=["T-507", "T-605"],
        evidence=[
            ("Twenty methods with hierarchy and authoring shapes", "src/shared/protocol.ts"),
            ("Contract suite: exact set plus per-method fixtures", "tests/protocol.contract.test.ts"),
        ],
        out_of_scope=["Serving any of it, which is T-802; TUI consumption, which is EP-09."],
    ),
    Task(
        id="T-802", slug="daemon-hierarchy", title="Daemon hierarchy: parented spawns, cascades, orphan refusal",
        epic="EP-08", sprint="SP-09", status="Done",
        goal="The daemon records who deployed whom, enforces the hierarchy rules, and never leaves an orphan running.",
        read_first=[
            ARCH,
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
            ("Daemon entry point", "src/daemon/main.ts"),
            ("Persistence", "src/daemon/db.ts"),
        ],
        files=[
            "src/daemon/db.ts",
            "src/daemon/main.ts",
            "src/daemon/socket.ts",
            "tests/daemon-hierarchy.test.ts",
        ],
        assets=[
            ("src/daemon/db.ts", "Edited", "`agents.parent` column (recreate per the pre-release precedent), tree reads, orphan listing."),
            ("src/daemon/main.ts", "Edited", "Spawn with parent: cycle rejection, account inheritance, family channel; kill cascades with an explicit keep-children reparent; boot refuses orphaned agents and reports them."),
            ("src/daemon/socket.ts", "Edited", "Serves T-801's new methods against the store and registry; status carries parent/children."),
            ("tests/daemon-hierarchy.test.ts", "New", "Tree, cascade, orphan, and cycle cases over the real socket."),
        ],
        steps=[
            "Persist `parent` on the agents table at spawn and expose tree reads (children of, ancestors of).",
            "On `agent_spawn` with `parent`: reject when the parent is unknown, when the walk from parent reaches the child (cycle), or when the parent is stopped; inherit the parent's account; create and join `#<parent>-team` in place of the parent's rooms.",
            "`agent_create` delegates to the peer-store write path (parse-validated, atomic); `definition_get`/`definition_update` read and rewrite definitions through the store, and an update that changes policy is answered by T-505's rebuild on next delivery — assert that handoff.",
            "`kill` stops the whole subtree by default; `keep_children: true` reparents children to root. Boot: an agent whose parent is absent from the registry is not started and is flagged `orphaned` in status.",
        ],
        acceptance=[
            "A spawned child persists its parent across a daemon restart.",
            "A cycle is rejected at spawn with the path named.",
            "Killing a parent stops its children; keep-children reparents them to root.",
            "An agent whose parent is gone is not woken at boot and is flagged orphaned.",
            "A child inherits the parent's account and joins the family channel, not the parent's rooms.",
            "A definition update that changes policy is followed by a rebuild on next delivery (T-505's path, exercised end to end).",
        ],
        depends_on=["T-801"],
        evidence=[
            ("Hierarchy state and rules in the daemon", "src/daemon/main.ts"),
            ("Hierarchy suite, 30 tests with 18 revert-probes", "tests/daemon-hierarchy.test.ts"),
        ],
        out_of_scope=["The toolbelt caller side (T-803) and the TUI tree (EP-09)."],
    ),
    Task(
        id="T-803", slug="toolbelt-authoring", title="Toolbelt: create and parent agents",
        epic="EP-08", sprint="SP-09", status="Done",
        goal="A worker can author and deploy a child peer without leaving its run, and knows when not to.",
        read_first=[
            ("Toolbelt", "src/worker/toolbelt.ts"),
            ("ADR-007: native task delegation", "docs/delivery/adr/ADR-007-native-task-delegation.md"),
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
        ],
        files=["src/worker/toolbelt.ts", "tests/toolbelt.test.ts"],
        assets=[
            ("src/worker/toolbelt.ts", "Edited", "`agent_create` tool; `agent_spawn` passes `parent` as the calling worker's own name."),
            ("tests/toolbelt.test.ts", "Edited", "Authoring flows over the real socket."),
        ],
        steps=[
            "Add the `agent_create` tool: validates fields, calls the socket method, reports the parser's errors verbatim so the model can fix and retry.",
            "Teach `agent_spawn` to send `parent` as the worker's own name when it wants a child; the tool description states the cooperative-metadata rule (ADR-011) plainly.",
            "Extend the tool descriptions' selection guidance: native `task` for temporary in-run subagents, child peers for durable teammates, `agent_spawn` without parent for top-level peers. The ADR-007 subtask refusal stays.",
        ],
        acceptance=[
            "A worker creates then spawns a child in one run, over the real socket, with the parent recorded.",
            "A definition the parser rejects comes back as a tool error carrying the parser's message and no half-written file.",
            "The child-vs-task guidance is asserted in the tool descriptions so it cannot silently drift.",
        ],
                evidence=[("agent_create + parented spawn tools", "src/worker/toolbelt.ts"), ("Authoring flows over the real socket", "tests/toolbelt.test.ts")],
        depends_on=["T-802"],
        out_of_scope=["Connection identity for spawner proof; ADR-011 records why the param is cooperative."],
    ),
    Task(
        id="T-804", slug="authoring-skills", title="Shipped skills for agent and subagent authoring",
        epic="EP-08", sprint="SP-09", status="Done",
        goal="Creating an agent or subagent is a guided skill, not a search through the codebase.",
        read_first=[
            ("Skill discovery in OMP", "node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/skills.ts"),
            ("Materializer skill wiring", "src/daemon/materializer.ts"),
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
        ],
        files=[
            "skills/omp-agent-authoring/SKILL.md",
            "skills/omp-subagent-authoring/SKILL.md",
            "skills/omp-orchestration/SKILL.md",
            "tests/skills.test.ts",
            "package.json",
        ],
        assets=[
            ("skills/omp-agent-authoring/SKILL.md", "New", "Authoring a peer definition: format, rooms, wake, autonomy, sandbox, spawns — with the strict parser's error codes."),
            ("skills/omp-subagent-authoring/SKILL.md", "New", "Authoring native `task` subagents: when temporary is right, spawns policy, output contract."),
            ("skills/omp-orchestration/SKILL.md", "New", "The selection guide: task vs child peer vs top-level peer vs room message."),
            ("tests/skills.test.ts", "New", "OMP's real `loadSkills` discovers all three from the package root; frontmatter parses with required fields."),
            ("package.json", "Edited", "Ships `skills/` in `files` if the manifest does not already cover them."),
        ],
        steps=[
            "Write the three skills in OMP's SKILL.md format (`name` + `description` required), each with the exact frontmatter shape, a worked example, and the failure modes a first-timer hits.",
            "Prove discovery with OMP's real `loadSkills`/`discoverSkills` against the package root, so an OMP upgrade that breaks the plugins provider fails our suite, not the user.",
            "Wire the materializer: a peer definition's `skills:` key selects these by name and they land in the worker root (the mechanism exists; prove it with a materialization test).",
        ],
        acceptance=[
            "All three skills are discovered by OMP's real loader from the installed package layout.",
            "Each skill's frontmatter parses and carries the required fields.",
            "A worker whose definition selects a skill receives it in the materialized root.",
        ],
        depends_on=["T-501"],
        evidence=[
            ("Three skills in OMP's package layout", "skills/omp-orchestration/SKILL.md"),
            ("Discovery pinned against the real loader, 5 tests", "tests/skills.test.ts"),
        ],
        out_of_scope=["Auto-learning skills from sessions (OMP's managed-skills feature is not ours to drive)."],
    ),
]

TASKS += [
    # ── EP-09: full TUI management surface ────────────────────────────────────
    Task(
        id="T-901", slug="tui-tree", title="Hierarchy in /agents and the spawn flow",
        epic="EP-09", sprint="SP-10", status="Done",
        goal="`/agents` renders the agent tree, and `/spawn` can parent a new peer.",
        read_first=[
            ("Commands", "src/extension/commands.ts"),
            ("Widget", "src/extension/widget.ts"),
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
        ],
        files=["src/extension/commands.ts", "src/extension/widget.ts", "tests/extension.test.ts"],
        assets=[
            ("src/extension/commands.ts", "Edited", "Tree rendering in `/agents`; parent picker in `/spawn`; orphan flag visible."),
            ("src/extension/widget.ts", "Edited", "Widget counts stay flat (roots + children); the tree belongs to the command and the manager."),
            ("tests/extension.test.ts", "Edited", "Tree shape assertions over the real socket."),
        ],
        steps=[
            "Render `/agents` as an indented tree from the status payload's parent/children fields, with the shield and the orphaned marker.",
            "`/spawn` gains an optional parent selection (a `select` dialog over live peers; root when declined).",
            "Keep the string-array widget as-is — it caps at ten lines and the tree does not belong there.",
        ],
        acceptance=[
            "A child renders nested under its parent; an orphaned peer is flagged.",
            "Spawning with a chosen parent lands the child under it, visible on the next `/agents`.",
            "Every flow degrades cleanly when the daemon is absent.",
        ],
                evidence=[("Tree rendering and parent picker", "src/extension/commands.ts"), ("Tree shape, orphan marker, and wire-level parent assertions", "tests/extension.test.ts")],
        depends_on=["T-802"],
        out_of_scope=["The full-screen manager, which is T-902."],
    ),
    Task(
        id="T-902", slug="tui-manager", title="Full-screen agent manager",
        epic="EP-09", sprint="SP-10", status="Done",
        goal="A full-screen overlay inside the OMP TUI is the operator's management surface for the agent tree.",
        read_first=[
            ("Extension factory", "src/extension/index.ts"),
            ("OMP custom-surface API", "node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts"),
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
        ],
        files=["src/extension/manager.ts", "src/extension/index.ts", "tests/extension.test.ts"],
        assets=[
            ("src/extension/manager.ts", "New", "The overlay component: tree browse, per-agent action menu, kill with cascade choice, logs, inject, membership editing."),
            ("src/extension/index.ts", "Edited", "Registers `/manage` and a shortcut; guards `ctx.hasUI`/`ctx.mode`."),
            ("tests/extension.test.ts", "Edited", "Manager state logic against the real socket; the component is split so logic is testable without a TTY."),
        ],
        steps=[
            "SPIKE FIRST and timebox it: a minimal full-screen overlay rendering the tree and dismissing on Esc, proven in a real OMP TUI session by hand before building further — `ctx.ui.custom` with `overlay: true, fullscreen: true` is the least-documented surface in play.",
            "Split the manager into a pure state layer (tree model, selected node, pending action) and the component factory, so the suite drives the state layer against the real socket without a TTY.",
            "Actions per agent: edit definition/model (T-903's flows), logs, inject, kill — with the cascade choice presented explicitly (`kill subtree` vs `keep children`).",
            "Degrade: without a TUI the command reports that the manager needs one; without a daemon it says so and offers nothing broken.",
        ],
        acceptance=[
            "The overlay opens over the transcript, browses the tree by keyboard, and closes cleanly without disturbing the session.",
            "Every action goes through the daemon socket; the manager holds no state the daemon does not own.",
            "The state layer is covered by tests driving the real socket; the spike's risks are named in the report.",
        ],
                evidence=[("Fullscreen overlay manager with the state/component split", "src/extension/manager.ts"), ("Manager state layer over the real socket, 41 extension tests", "tests/extension.test.ts")],
        depends_on=["T-901"],
        out_of_scope=["Editing flows themselves, which are T-903."],
    ),
    Task(
        id="T-903", slug="tui-editing", title="Definition and model editing flows",
        epic="EP-09", sprint="SP-10", status="Done",
        goal="An operator edits an agent's definition and model in guided dialogs, and the change persists and takes effect.",
        read_first=[
            ("Commands", "src/extension/commands.ts"),
            ("OMP editor/select dialog API", "node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts"),
        ],
        files=["src/extension/commands.ts", "src/extension/manager.ts", "tests/extension.test.ts"],
        assets=[
            ("src/extension/commands.ts", "Edited", "`/edit <name>` flows: definition via pre-filled editor, model via selection over configured roles."),
            ("src/extension/manager.ts", "Edited", "The manager's edit actions call the same flows."),
            ("tests/extension.test.ts", "Edited", "Edit round trips against the real socket: get → edit → update → staleness handoff."),
        ],
        steps=[
            "`definition_get` → `ctx.ui.editor` with the current document pre-filled → `definition_update` on submit; a parser refusal redisplays the editor with the error, because losing an operator's edit to a validation throw is how dialogs get hated.",
            "Model editing is a `select` over the configured model roles plus free input; the change persists through `definition_update` and takes effect via the T-505 rebuild on next delivery.",
            "Assert the handoff: an edited definition reports `rebuildRequired` and the next delivery rebuilds (the daemon suite's T-505 path, driven from the extension suite).",
        ],
        acceptance=[
            "An edited definition persists to the store and reparses; a refused edit loses no input.",
            "A model change is reflected in the worker's next session without a daemon restart.",
            "Both flows are reachable from `/edit` and from the manager.",
        ],
                evidence=[("Guided edit flows with refusal-preserving editor", "src/extension/commands.ts"), ("Round-trip, refusal, and rebuild surfacing in the extension suite", "tests/extension.test.ts")],
        depends_on=["T-801", "T-901"],
        out_of_scope=["Spawning new agents from the editor, which `/spawn` and T-901 cover."],
    ),
]

TASKS += [
    # ── EP-10: production wiring ─────────────────────────────────────────────
    Task(
        id="T-1001", slug="console-mounted-at-boot", title="Serve the console from the daemon",
        epic="EP-10", sprint="SP-11", status="Done",
        goal="The daemon itself serves the console API and the client, behind an operator token — the browser UI has a backend to reach.",
        read_first=[
            ARCH,
            ("Console API", "src/daemon/console-api.ts"),
            ("Console guide", "docs/web-console.md"),
            ("Daemon entry point", "src/daemon/main.ts"),
        ],
        files=[
            "src/daemon/main.ts",
            "src/daemon/console-api.ts",
            "tests/daemon-console-mount.test.ts",
            "docs/web-console.md",
        ],
        assets=[
            ("src/daemon/main.ts", "Edited", "Boots the console server beside the control socket; token generation and storage; shutdown order."),
            ("src/daemon/console-api.ts", "Edited", "Serves the client statics from `src/console/` on the same listener; the API routes are unchanged."),
            ("tests/daemon-console-mount.test.ts", "New", "Boot → fetch the shell and the API with the token; restart reuses the stored token; shutdown releases the port."),
            ("docs/web-console.md", "Edited", "The 'Running it' section stops describing the future."),
            ("src/console/", "Read", "The client being served."),
        ],
        steps=[
            "Generate the operator token at first boot (crypto random), store it mode-0600 under the state dir, and print the console URL once at startup. A stored token is reused on restart; rotating is deleting the file.",
            "Mount `startConsoleApi` in `bootDaemon` on loopback with a configurable port (env override, default 0 = ephemeral and printed), and close it in the reverse-order shutdown before the store closes.",
            "Serve `src/console/` statics at `/` on the same listener: index.html, app.js, style.css, with correct content types and no path traversal (resolve-and-contain, same standard as the peer-store write).",
            "Everything off by default is wrong for the surface's purpose — but an env kill-switch (e.g. OMA_CONSOLE=0) keeps a daemon headless when wanted.",
        ],
        acceptance=[
            "Booting the daemon serves the client at `/` and the API at `/api/*` on one loopback listener.",
            "The printed URL works in a browser; a request without the token is 401.",
            "A restart keeps the same token; the token file is mode 0600.",
            "Shutdown frees the port and a second boot binds cleanly.",
        ],
                evidence=[("Console mounted with the operator-token lifecycle", "src/daemon/main.ts"), ("Mount suite, 24 tests incl. traversal and token-reuse cases", "tests/daemon-console-mount.test.ts")],
        depends_on=["T-602", "T-603"],
        out_of_scope=["Binding beyond loopback, which is what T-1004 is for."],
    ),
    Task(
        id="T-1002", slug="usage-feeds-the-meter", title="Usage feeds the meter",
        epic="EP-10", sprint="SP-11", status="Done",
        goal="A metered account's meter moves with real usage, so the 80% warning and 100% park (T-506) fire on reality.",
        read_first=[
            ARCH,
            ("Credential gateway usage routes", "src/daemon/credential-gateway.ts"),
            ("Account registry", "src/daemon/account-registry.ts"),
            ("Supervisor budget flow", "src/daemon/supervisor.ts"),
        ],
        files=[
            "src/daemon/main.ts",
            "src/daemon/account-registry.ts",
            "src/shared/agent-definition.ts",
            "tests/usage-meter.test.ts",
        ],
        assets=[
            ("src/daemon/main.ts", "Edited", "The account→credential binding at spawn (worker tokens stop being bound to zero credentials) and the usage polling loop."),
            ("src/daemon/account-registry.ts", "Edited", "updateMeter is driven with a dollars-burned fraction computed from usage."),
            ("src/shared/agent-definition.ts", "Edited", "An account/credential field on the definition, if the binding is declared there — decide and document."),
            ("tests/usage-meter.test.ts", "New", "Usage moves the meter; the 80% warning posts; the park fires at the cap; no usage means no movement."),
        ],
        steps=[
            "Bind worker tokens to the account's credentials instead of an empty list (the current `credentialIds: []` placeholder in main.ts is the gap — an unbound token sees nothing).",
            "Poll the gateway's usage routes on an interval and convert dollars to the 0..1 meter per metered account (`budgetUsd` is the denominator).",
            "Drive `registry.updateMeter`; the T-506 warn/park/bump flow does the rest, unchanged.",
            "Stop polling when nothing is running; an unattended daemon does not burn gateway calls.",
        ],
        acceptance=[
            "Reported usage moves the meter, and crossing 80% posts the warning naming the account and budget.",
            "Reaching the cap parks the account's runs; a bump resumes them (T-506's tests keep passing).",
            "A subscription account's meter never moves.",
        ],
                evidence=[("Binding and poll loop in the daemon", "src/daemon/main.ts"), ("Usage-meter suite, 6 tests with three revert-proofs", "tests/usage-meter.test.ts")],
        depends_on=["T-301", "T-506"],
        out_of_scope=["Usage display in the TUI/console (read models exist; presenting them is a future UI task)."],
    ),
    Task(
        id="T-1003", slug="worker-pid-on-the-wire", title="Worker pid in status and the registry",
        epic="EP-10", sprint="SP-11", status="Done",
        goal="A running worker's OS pid is visible in status and recorded in the agents table, so an operator can find the process.",
        read_first=[
            ("Lifecycle", "src/worker/lifecycle.ts"),
            ("Daemon db", "src/daemon/db.ts"),
            ("Protocol", "src/shared/protocol.ts"),
        ],
        files=[
            "src/worker/lifecycle.ts",
            "src/daemon/main.ts",
            "src/daemon/socket.ts",
            "src/shared/protocol.ts",
            "src/shared/protocol-schemas.ts",
            "tests/worker-lifecycle.test.ts",
            "tests/daemon-main.test.ts",
            "patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch",
            "package.json",
        ],
        assets=[
            ("src/worker/lifecycle.ts", "Edited", "`WorkerHandle.pid` from the spawned child (undefined while parked)."),
            ("src/daemon/main.ts", "Edited", "Records the pid in the agents table at spawn/respawn, clears it at stop."),
            ("src/shared/protocol.ts", "Edited", "`AgentStatus.pid?: number` — optional, additive."),
            ("src/shared/protocol-schemas.ts", "Edited", "Accept the optional field."),
            ("src/daemon/socket.ts", "Edited", "`toAgentStatus` emits the live pid."),
            ("patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch", "New", "Upstream `RpcClient.pid` accessor, reapplied by bun install; file the equivalent upstream."),
            ("package.json", "Edited", "`patchedDependencies` records the patch."),
            ("tests/worker-lifecycle.test.ts", "Edited", "A real child's pid is reported and dead after stop."),
            ("tests/daemon-main.test.ts", "Edited", "Status carries the pid of a running peer."),
        ],
        steps=[
            "Expose the child pid on WorkerHandle (the RPC client's process) — undefined while parked, since a parked peer has no process.",
            "Record it in the agents table at spawn and respawn; clear it when the worker stops; the row never shows a dead pid after a clean shutdown.",
            "Add the optional field to the wire status and validators; the TUI manager may show it, but that is not required here.",
        ],
        acceptance=[
            "A real child's pid is exposed and the process is gone after stop.",
            "Status over the socket carries the pid for a running peer and none for a parked one.",
            "The agents row's worker_pid matches the live process while running.",
        ],
                evidence=[("Patched RpcClient.pid accessor", "patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch"), ("Pid recorded and cleared across the lifecycle", "src/daemon/main.ts")],
        depends_on=["T-401"],
        out_of_scope=["Killing by pid from the operator surfaces (kill stays logical, by name)."],
    ),
    Task(
        id="T-1004", slug="control-socket-identity", title="Connection identity on the control socket",
        epic="EP-10", sprint="SP-11", status="Planned",
        goal="When the control socket ever needs to distinguish callers, each client presents a credential and the daemon can enforce per-identity rules — including making agent hierarchy authoritative instead of cooperative.",
        read_first=[
            ARCH,
            ("ADR-011: agent hierarchy", "docs/delivery/adr/ADR-011-agent-hierarchy.md"),
            ("Socket server", "src/daemon/socket.ts"),
        ],
        files=[
            "src/daemon/socket.ts",
            "src/daemon/main.ts",
            "src/worker/toolbelt.ts",
            "src/extension/widget.ts",
            "src/shared/protocol.ts",
            "tests/socket-identity.test.ts",
        ],
        assets=[
            ("src/daemon/socket.ts", "Edited", "Per-connection bearer: workers get their scoped token, the TUI/console the operator token."),
            ("src/daemon/main.ts", "Edited", "Issues and stores the credentials; the pidfile dir already protects the socket path."),
            ("src/worker/toolbelt.ts", "Edited", "Presents the worker's token from its env."),
            ("src/extension/widget.ts", "Edited", "Reads the operator token from the state file."),
            ("src/shared/protocol.ts", "Edited", "The auth failure shape."),
            ("tests/socket-identity.test.ts", "New", "Unauthenticated calls refused; a worker's kill of a peer it does not own is refused."),
        ],
        steps=[
            "Pick this up WHEN: the console or socket binds beyond loopback, or parentage needs to be authoritative (ADR-011's stated precondition).",
            "Issue per-identity bearer tokens at boot (worker tokens exist at the gateway; this is the control socket's own layer).",
            "Enforce: unauthenticated → unauthorized; a worker's parent claims must equal its identity; kill/bump/inject are operator-only.",
            "Keep loopback trust as the documented default for the local single-operator case; identity is the hardening layer, not a tax on it.",
        ],
        acceptance=[
            "An unauthenticated socket call is refused with the declared error shape.",
            "A worker token cannot kill or inject into a peer it does not own.",
            "The operator token path keeps today's TUI/console flows working unchanged.",
        ],
        depends_on=["T-502"],
        out_of_scope=["Replacing loopback as the default trust model; this task exists so the trigger is named, not to add ceremony today."],
    ),
    Task(
        id="T-1005", slug="worker-env-allowlist", title="Allowlist the worker environment",
        epic="EP-10", sprint="SP-11", status="Planned",
        goal="A worker's process env contains only what its layout declares — provider keys and other host secrets in the daemon's environment never reach a child.",
        read_first=[
            ("Env scrub", "src/shared/env-scrub.ts"),
            ("Materializer env", "src/daemon/materializer.ts"),
            ("ADR-002: materialized roots", "docs/delivery/adr/ADR-002-private-store-materialized-roots.md"),
        ],
        files=[
            "src/daemon/materializer.ts",
            "src/worker/lifecycle.ts",
            "src/shared/env-scrub.ts",
            "tests/materializer.test.ts",
        ],
        assets=[
            ("src/daemon/materializer.ts", "Edited", "The worker env becomes an allowlist, not a blanklist."),
            ("src/worker/lifecycle.ts", "Edited", "The spawn env is exactly the layout's env plus declared passthroughs."),
            ("src/shared/env-scrub.ts", "Edited", "The canonical list gains the allowlist side."),
            ("tests/materializer.test.ts", "Edited", "A poisoned host env (OPENAI_API_KEY etc.) reaches the worker only when declared."),
        ],
        steps=[
            "Pick this up WHEN workers run definitions from authors you do not fully trust, or the daemon host env carries provider keys (it usually does). T-205 scrubbed the config-root selectors; this is the rest of the host env.",
            "Invert the scrub: the spawned env is the layout's declared map plus an explicit passthrough list (PATH, HOME-shape basics, locale), never `...Bun.env` of the host.",
            "Prove with a poisoned host env that nothing undeclared reaches the child, including through the sandbox-gate launch path.",
        ],
        acceptance=[
            "A host exporting provider keys produces a worker env without them.",
            "The declared passthroughs keep the child functional (the real-child suites stay green).",
            "The sandbox launch path is covered by the same assertions.",
        ],
        depends_on=["T-205"],
        out_of_scope=["OS sandboxing itself (EP-02, shipped) and network egress policy (sandbox-bridge territory)."],
    ),
    Task(
        id="T-1006", slug="in-process-worker-path", title="In-process worker path for cheap agents",
        epic="EP-10", sprint="SP-11", status="Planned",
        goal="Short-lived or cheap agents run in-process via the SDK behind the same worker interface, when process-per-agent proves heavy in practice.",
        read_first=[
            ARCH,
            ("Worker lifecycle", "src/worker/lifecycle.ts"),
            ("ADR-001: RPC subprocess workers", "docs/delivery/adr/ADR-001-rpc-subprocess-workers.md"),
        ],
        files=[
            "src/worker/lifecycle.ts",
            "src/daemon/main.ts",
            "tests/worker-inprocess.test.ts",
        ],
        assets=[
            ("src/worker/lifecycle.ts", "Edited", "An in-process backend satisfying SupervisedWorker behind the existing interface."),
            ("src/daemon/main.ts", "Edited", "The spawn path selects the backend from the definition or a daemon flag."),
            ("tests/worker-inprocess.test.ts", "New", "The same supervisor contract suite drives both backends."),
        ],
        steps=[
            "Pick this up WHEN the RPC-per-agent cost is measured to matter (memory, startup latency at many peers) — not before; ADR-001 chose crash isolation first.",
            "Implement the in-process session behind SupervisedWorker; no sandbox applies to it, so it is for trusted cheap agents only and `/agents` must never show a shield for one.",
            "The supervisor contract suite runs against both backends, so the optimization cannot fork behavior.",
        ],
        acceptance=[
            "Both backends pass the same supervisor contract suite.",
            "An in-process worker never shows the sandbox shield.",
            "The default stays RPC subprocess.",
        ],
        depends_on=["T-401"],
        out_of_scope=["Sandboxing in-process workers — impossible; the shield rules make that visible rather than implied."],
    ),
]

TASK_FILE = {t.id: f"{t.id}-{t.slug}.md" for t in TASKS}
TASK_BY_ID = {t.id: t for t in TASKS}

# `Unblocks` is not authored. It is the inverse of `depends_on`, computed once
# here, because two hand-maintained halves of the same edge drift apart and the
# drift is invisible until someone acts on the wrong half.
DEPENDENTS = {t.id: [o.id for o in TASKS if t.id in o.depends_on] for t in TASKS}

EPIC_TASKS = {e.id: [t for t in TASKS if t.epic == e.id] for e in EPICS}
SPRINT_TASKS = {s.id: [t for t in TASKS if t.sprint == s.id] for s in SPRINTS}


# ── Index documents ───────────────────────────────────────────────────────────


def render_readme() -> str:
    total = len(TASKS)
    done = len([t for t in TASKS if t.status == "Done"])
    nxt = lambda i: f"[{i}](tasks/{TASK_FILE[i]})"  # noqa: E731
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
        f"**{done} of {total} tasks Done.** Suite state is not restated here, because a "
        "pasted count rots the day after it is pasted: CI runs `tsc --noEmit` and `bun test` "
        "on every push, and `bun test` locally gives you the same answer.",
        "",
        "Every runtime subsystem is built and under test: workers, isolation, credentials, "
        "rooms, scheduling, and quota handling. Two things keep that from meaning finished.",
        "",
        "First, there is no operator surface. The extension entry point is an empty factory "
        "and there is no daemon binary, so nothing here can currently be launched or looked "
        "at by a human (EP-05).",
        "",
        "Second, the release surface is one push old: the CI workflow, lint "
        "configuration, and root README now exist (EP-07), but the workflow has "
        "never run on a runner — T-701 stays In progress until a push proves it.",
        "",
        "The credential gateway is now verified at its consumer as well as its wire: a "
        "stock `RemoteAuthCredentialStore` drives it in "
        "[T-303](tasks/T-303-client-integration.md), which found and fixed a real shutdown "
        "defect — a daemon would hang on exit while any worker was parked on a long-poll.",
        "",
        "## Unit contract",
        "",
        "Every task file carries the same eight sections in the same order: Goal, Read first, "
        "Files this task may change, Modules and assets in play, Steps, Acceptance, and then "
        "Out of scope, Depends on, Unblocks. Anything else is drift.",
        "",
        "`Unblocks` is derived by inverting `Depends on`, so the two halves of an edge "
        "cannot disagree. Only `Depends on` is authored.",
        "",
        "Epic and sprint status is derived from the tasks inside it, not written down "
        "separately, so a container can never claim to be further along than its children.",
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
                    status_cell(*container_status(e, EPIC_TASKS[e.id])),
                    str(len(EPIC_TASKS[e.id])),
                ]
                for e in EPICS
            ],
        ),
        "",
        "## Sprints",
        "",
        table(
            ["Sprint", "Title", "Status", "Theme"],
            [
                [
                    f"[{s.id}](sprints/{SPRINT_FILE[s.id]})",
                    s.title,
                    status_cell(*container_status(s, SPRINT_TASKS[s.id])),
                    s.theme,
                ]
                for s in SPRINTS
            ],
        ),
        "",
        "## Decisions",
        "",
        table(["ADR status", "Meaning"], [[s, m] for s, m in ADR_STATUS_LEGEND]),
        "",
        table(
            ["ADR", "Title", "Status"],
            [[f"[{a.id}](adr/{ADR_FILE[a.id]})", a.title, a.status] for a in ADRS],
        ),
        "",
        "## What to do next",
        "",
        "EP-05 opens on two independent fronts: " + nxt("T-507") + " freezes the "
        "control-socket protocol and " + nxt("T-501") + " loads peer definitions. "
        + nxt("T-502") + " needs both, and " + nxt("T-508") + " needs T-502 because the "
        "orphan sweep reads the registry T-502 persists. After that "
        + ", ".join(nxt(i) for i in ["T-503", "T-504", "T-505", "T-506", "T-509"])
        + " are independent of each other and can run in parallel.",
        "",
        nxt("T-601") + " (the conversation model) depends on nothing in EP-05 and can run "
        "alongside any of it. Everything else in EP-06 needs the daemon API from T-502.",
        "",
        "EP-07 is unblocked today: "
        + ", ".join(nxt(i) for i in ["T-701", "T-702", "T-703"])
        + " have no dependencies and are worth landing early, because CI is what stops the "
        "rest of this list from regressing silently.",
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
        "The generator renders into a staging directory, runs every gate against what it "
        "just rendered, and only then replaces this tree. A failed gate leaves the previous "
        "tree exactly as it was.",
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


def render_all() -> dict[str, str]:
    pages: dict[str, str] = {
        "README.md": render_readme(),
        "asset-map.md": render_asset_map(),
    }
    for a in ADRS:
        pages[os.path.join("adr", ADR_FILE[a.id])] = render_adr(a)
    for e in EPICS:
        pages[os.path.join("epics", EPIC_FILE[e.id])] = render_epic(e, EPIC_TASKS[e.id])
    for s in SPRINTS:
        pages[os.path.join("sprints", SPRINT_FILE[s.id])] = render_sprint(s, SPRINT_TASKS[s.id])
    for t in TASKS:
        pages[os.path.join("tasks", TASK_FILE[t.id])] = render_task(t)
    return pages


def main() -> None:
    """Render, verify, then swap.

    The old shape deleted `docs/delivery` first and verified last, so a failed
    gate left the tree half-written and the previous good copy gone. Here the
    render lands in a staging sibling — same depth, so relative links resolve
    identically — and the live tree is replaced only after every gate passes.
    """
    staging = DELIVERY + ".staging"
    shutil.rmtree(staging, ignore_errors=True)

    pages = render_all()
    for sub in ("epics", "sprints", "tasks", "adr"):
        os.makedirs(os.path.join(staging, sub), exist_ok=True)
    for relpath, body in pages.items():
        with open(os.path.join(staging, relpath), "w") as fh:
            fh.write(body)
    print(f"rendered {len(pages)} files into {os.path.relpath(staging, ROOT)}")

    try:
        verify(pages, staging)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        print("gates failed; previous tree left untouched")
        raise

    shutil.rmtree(DELIVERY, ignore_errors=True)
    os.rename(staging, DELIVERY)
    print(f"wrote {len(pages)} files to {os.path.relpath(DELIVERY, ROOT)}")


# ── Verification gates ────────────────────────────────────────────────────────

FORBIDDEN = {"\u00a0": "non-breaking space", "\ufffd": "replacement char"}
SECRET_MARKERS = [
    r"\bsk-[A-Za-z0-9]{16,}",
    r"\bghp_[A-Za-z0-9]{20,}",
    r"BEGIN [A-Z ]*PRIVATE KEY",
    r"\bxoxb-[A-Za-z0-9-]{10,}",
    r"_TOKEN=\S+",
]

SOURCE_ROOTS = ("src", "tests")


def verify(pages: dict[str, str], base: str) -> None:
    """Gate the rendered content, not the tree on disk.

    `pages` is what was just rendered; `base` is where it was staged, needed
    only to resolve relative links between the documents themselves.
    """
    failures: list[str] = []

    # Gate 1: forbidden characters.
    hits = 0
    for relpath, text in pages.items():
        for ch, name in FORBIDDEN.items():
            if ch in text:
                hits += text.count(ch)
                failures.append(f"{relpath}: contains {name}")
    print(f"gate: forbidden characters -> {hits} (expect 0)")

    # Gate 2: secret markers.
    leaks = 0
    for relpath, text in pages.items():
        for m in SECRET_MARKERS:
            for hit in re.findall(m, text):
                leaks += 1
                failures.append(f"{relpath}: matches {m!r} -> {hit[:12]}")
    print(f"gate: credential markers -> {leaks} (expect 0)")

    # Gate 3: relative link resolution. A gate that checks 0 links passes silently,
    # so report the total checked alongside the broken count.
    checked = broken = 0
    link = re.compile(r"\]\(([^)]+)\)")
    for relpath, text in pages.items():
        dirname = os.path.dirname(os.path.join(base, relpath))
        for target in link.findall(text):
            if target.startswith(("http://", "https://", "#")):
                continue
            checked += 1
            resolved = os.path.normpath(os.path.join(dirname, target.split("#")[0]))
            # A link that points back into `docs/delivery` by repo-relative path
            # must be checked against what was just rendered, not against the
            # live tree: otherwise a new page validates only on the second run.
            if resolved == DELIVERY or resolved.startswith(DELIVERY + os.sep):
                resolved = os.path.join(base, os.path.relpath(resolved, DELIVERY))
            if not os.path.exists(resolved):
                broken += 1
                failures.append(f"{relpath}: broken link -> {target}")
    print(f"gate: relative links -> {checked} checked, {broken} broken (expect 0)")

    # Gate 4a: every evidence path must exist on disk. Rendering a missing path
    # as plain text (rather than a link) hides it from the link gate, so this
    # gate is what actually catches a wrong anchor. Four bad OMP paths reached
    # the first draft this way. Delivery-tree targets are excluded: they live in
    # the staging tree and the link gate already checked them there.
    anchors = missing_anchor = 0
    for holder, pairs in (
        [(t.id, t.evidence) for t in TASKS] + [(a.id, a.evidence) for a in ADRS]
    ):
        for _claim, anchor in pairs:
            path = anchor_path(anchor)
            # A bare commit sha (or list of them) is not a path. Anything that
            # looks like a file, including a repo-root file with no slash, must
            # exist: requiring a slash left `ARCHITECTURE.md` unchecked.
            if re.fullmatch(r"[0-9a-f]{7}(, [0-9a-f]{7})*", anchor):
                continue
            if path.startswith("docs/delivery/"):
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

    # Gate 4c: every evidence row is anchored to a path, a section, or a sha.
    rows = unanchored = 0
    for holder, pairs in (
        [(t.id, t.evidence) for t in TASKS] + [(a.id, a.evidence) for a in ADRS]
    ):
        for claim, anchor in pairs:
            rows += 1
            sha = re.fullmatch(r"[0-9a-f]{7}(, [0-9a-f]{7})*", anchor)
            if not ("/" in anchor or "§" in anchor or sha):
                unanchored += 1
                failures.append(f"{holder}: unanchored evidence {claim!r} -> {anchor!r}")
    print(f"gate: evidence rows -> {rows} checked, {unanchored} unanchored (expect 0)")

    # Gate 4d: an ARCHITECTURE.md anchor must name a section, never a line
    # range. Line numbers were silently wrong in four ADRs after one edit to
    # that file; a section survives edits, and a wrong one is visible on sight.
    arch = stale = 0
    for holder, pairs in (
        [(t.id, t.evidence) for t in TASKS] + [(a.id, a.evidence) for a in ADRS]
    ):
        for claim, anchor in pairs:
            if anchor_path(anchor) != "ARCHITECTURE.md":
                continue
            arch += 1
            if "§" not in anchor:
                stale += 1
                failures.append(f"{holder}: ARCHITECTURE.md anchor is not a section -> {anchor!r}")
    print(f"gate: architecture anchors -> {arch} checked, {stale} line-numbered (expect 0)")

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
    for relpath, text in pages.items():
        if not relpath.startswith("tasks" + os.sep):
            continue
        headings = [ln.rstrip() for ln in text.splitlines() if ln.startswith("##")]
        if headings != expected:
            drifted += 1
            extra = [h for h in headings if h not in expected]
            failures.append(
                f"{relpath}: section drift"
                + (f", unexpected {extra}" if extra else f", got {headings}")
            )
    print(f"gate: task sections -> {len(TASKS)} files, {drifted} drifted (expect 0)")

    # Gate 5b: a container's effective status may not outrun its children.
    # Derivation makes this true by construction, so what this gate really
    # guards is a manual override that lies.
    inconsistent = 0
    for unit, children in (
        [(e, EPIC_TASKS[e.id]) for e in EPICS] + [(s, SPRINT_TASKS[s.id]) for s in SPRINTS]
    ):
        status, _ = container_status(unit, children)
        open_tasks = [t.id for t in children if t.status != "Done"]
        if status == "Done" and open_tasks:
            inconsistent += 1
            failures.append(f"{unit.id} is Done but holds open tasks {open_tasks}")
    print(
        f"gate: status consistency -> {len(EPICS) + len(SPRINTS)} containers, "
        f"{inconsistent} inconsistent (expect 0)"
    )

    # Gate 5c: a status override must carry its annotation, and vice versa. An
    # unexplained override is a hand-written status wearing a different hat.
    unexplained = 0
    for unit in list(EPICS) + list(SPRINTS):
        if unit.status_override and unit.status_override not in STATUSES:
            unexplained += 1
            failures.append(f"{unit.id}: unknown override status {unit.status_override!r}")
        if unit.status_override and not unit.status_note:
            unexplained += 1
            failures.append(f"{unit.id}: status override carries no annotation")
        if unit.status_note and not unit.status_override:
            unexplained += 1
            failures.append(f"{unit.id}: status annotation with nothing overridden")
    print(
        f"gate: status overrides -> {len(EPICS) + len(SPRINTS)} containers, "
        f"{unexplained} unexplained (expect 0)"
    )

    # Gate 6a: task contract shape.
    missing = 0
    for t in TASKS:
        if not t.acceptance or not t.steps or not t.files or not t.assets:
            missing += 1
            failures.append(f"{t.id}: incomplete contract")
    print(f"gate: task contract -> {len(TASKS)} tasks, {missing} incomplete (expect 0)")

    # Gate 6b: every file a task claims it may change must appear in its asset
    # table with a role. "Files this task may change" is the permission list and
    # the asset table is the explanation; a file in one and not the other means
    # a task is authorised to edit something nobody described.
    declared = unnamed = 0
    for t in TASKS:
        named = {p for p, _, _ in t.assets}
        for f in t.files:
            declared += 1
            if f not in named:
                unnamed += 1
                failures.append(f"{t.id}: may change {f} but never names it in assets")
    print(f"gate: files named as assets -> {declared} checked, {unnamed} unnamed (expect 0)")

    # Gate 6b-reverse: an asset a task creates or edits must appear in its
    # files list. "Files this task may change" is the permission list; a New or
    # Edited asset missing from it is work the task must do but is not
    # authorised to touch (T-501's shipped examples were exactly this).
    created = unlisted = 0
    for t in TASKS:
        for p, role, _ in t.assets:
            if role not in ("New", "Edited"):
                continue
            created += 1
            if p not in t.files:
                unlisted += 1
                failures.append(f"{t.id}: {role} asset {p} is not in its files list")
    print(f"gate: created assets listed -> {created} checked, {unlisted} unlisted (expect 0)")

    # Gate 6c: disk coverage. A module that exists but belongs to no task is
    # work nobody recorded, which is how `src/daemon/boot.ts` shipped with no
    # unit describing it. This is the only gate that reads the repository rather
    # than the tree.
    on_disk: list[str] = []
    for top in SOURCE_ROOTS:
        for dirpath, _dirs, names in os.walk(os.path.join(ROOT, top)):
            for n in names:
                if n.endswith(".ts"):
                    on_disk.append(os.path.relpath(os.path.join(dirpath, n), ROOT))
    named_anywhere = {p for t in TASKS for p, _, _ in t.assets}
    unowned = sorted(p for p in on_disk if p not in named_anywhere)
    for p in unowned:
        failures.append(f"on disk but named by no task: {p}")
    print(f"gate: disk coverage -> {len(on_disk)} modules, {len(unowned)} unowned (expect 0)")

    # Gate 7: the dependency graph resolves and is acyclic. A cycle is not a
    # slow build here, it is a set of tasks none of which can ever start.
    unknown = 0
    for t in TASKS:
        for dep in t.depends_on:
            if dep not in TASK_BY_ID:
                unknown += 1
                failures.append(f"{t.id}: depends on unknown task {dep}")

    state: dict[str, int] = {}
    cycles: list[str] = []

    def walk(node: str, trail: list[str]) -> None:
        state[node] = 1
        for dep in TASK_BY_ID[node].depends_on:
            if dep not in TASK_BY_ID:
                continue
            if state.get(dep) == 1:
                cycles.append(" -> ".join(trail + [node, dep]))
            elif state.get(dep, 0) == 0:
                walk(dep, trail + [node])
        state[node] = 2

    for t in TASKS:
        if state.get(t.id, 0) == 0:
            walk(t.id, [])
    for c in cycles:
        failures.append(f"dependency cycle: {c}")
    print(
        f"gate: dependency graph -> {len(TASKS)} tasks, {unknown} unknown, "
        f"{len(cycles)} cycles (expect 0)"
    )

    if failures:
        print("\nFAILURES:")
        for f in failures[:40]:
            print(f"  {f}")
        if len(failures) > 40:
            print(f"  ... and {len(failures) - 40} more")
        raise SystemExit(1)
    print("\nall gates pass")


if __name__ == "__main__":
    main()
