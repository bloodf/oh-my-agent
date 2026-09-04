# Delivery tree

Every unit of work is a task file under [`docs/delivery/`](../delivery/README.md) with the same nine headings in the same order: Goal, Read first, Files this task may change, Modules and assets in play, Steps, Acceptance, Out of scope, Depends on, Unblocks.

**Never hand-edit `docs/delivery/`.** It is generated. Author in [`scripts/gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py) and run `bun run docs`. CI fails on drift (`git diff --exit-code docs/`).

The generator header states the contract: one generator, one shape, so 100 task files cannot diverge by hand.

## Status values

| Status | Meaning |
|---|---|
| Done | Shipped, tested, and committed. The evidence table names the suite and commit. |
| In progress | Started, and at least one acceptance item is unmet. The gap is named in the epic. |
| Ready | Specified and unblocked. Everything it depends on is Done. |
| Blocked | Waiting on a listed dependency that is not Done, or on something named in Out of scope. |
| Planned | Specified, but not queued: nothing is waiting on it and nobody has picked it up. |

Epic and sprint status is **derived** from the tasks inside. Do not write container status by hand unless you also write `status_override` and `status_note` explaining why derivation is wrong.

ADR status: **Accepted** (in force; a change needs a new ADR) or **Proposed** (written, not built against yet).

`Unblocks` is the inverse of `Depends on`. Author only `depends_on`.

Task numbers follow the epic: `EP-00` owns `T-0xx`, `EP-12` owns `T-12xx`.

## How to pick a Ready task

1. Open [`docs/delivery/README.md`](../delivery/README.md).
2. Filter for **Ready**. Each task file lists the files it may change. That is the scope.
3. Read the task's Read first links, then the files, then implement against Acceptance.
4. A task listing more than about six files is too large. Split it in the generator rather than stretching the PR.

Today the tree is **95 of 100 Done**. Nothing is Ready. Five tasks are Blocked on things outside the repo:

| Task | Why it is Blocked |
|---|---|
| [T-1202](../delivery/tasks/T-1202-tls-termination.md) | Per-recipe real-proxy evidence. Caddy and SSH+Caddy are verified; tailscale serve still needs two tailnet devices. |
| [T-1205](../delivery/tasks/T-1205-exposure-runbook.md) | Depends on T-1202 |
| [T-1403](../delivery/tasks/T-1403-first-live-session.md) | Operator must run and record a live-account session |
| [T-1503](../delivery/tasks/T-1503-drop-resolve-walk.md) | Wait for a released Bun or pi-coding-agent fix |
| [T-1504](../delivery/tasks/T-1504-drop-rpc-pid-patch.md) | Wait for a released `RpcClient.pid` accessor |

If you have the missing infrastructure (second tailnet device, live accounts, or the upstream release), that is the highest-leverage contribution. Otherwise: file a bug with a reproduction, or add a new task for new behavior.

## Adding a task

Edit the generator, not the markdown.

1. Find the `TASKS` / `TASKS +=` block for the epic in [`scripts/gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py).
2. Append a `Task(...)`. Required fields match the `Task` dataclass at the top of that file:

```python
Task(
    id="T-16xx",
    slug="short-slug",
    title="Imperative title",
    epic="EP-16",
    sprint="SP-17",
    status="Ready",  # or Planned / Blocked
    goal="One sentence the implementer can finish.",
    read_first=[("ARCHITECTURE.md", "ARCHITECTURE.md")],
    files=["src/foo.ts", "tests/foo.test.ts"],
    assets=[
        ("src/foo.ts", "Edited", "What changes."),
        ("tests/foo.test.ts", "New", "What the suite proves."),
    ],
    steps=["Write the failing test.", "Implement the narrowest change."],
    acceptance=["A named suite fails when the production line is reverted."],
    depends_on=["T-1601"],          # omit if none; do not author Unblocks
    out_of_scope=["The thing this task is not."],
)
```

3. Every path in `files` must appear in `assets`. Roles are `New`, `Edited`, or a read-only note. New epics or sprints need entries in `EPICS` / `SPRINTS` as well.
4. Disk coverage: source under `src/` and `tests/` must be owned by some task's assets. An unowned new module fails the `disk coverage` gate.
5. Regenerate:

```sh
bun run docs
bun run docs
git diff --exit-code docs/
```

The second run must produce no diff. The generator renders into a staging directory, runs every gate, and only then replaces `docs/delivery/`. A failed gate leaves the previous tree untouched.

Gates (all print `(expect 0)`): forbidden characters, credential markers, relative links, evidence paths, read-only assets, evidence rows, architecture anchors, task sections, status consistency, status overrides, task contract, files named as assets, created assets listed, disk coverage, dependency graph.

## Making the change

For anything beyond a typo:

1. Find or add the task.
2. Write the test first, watch it fail. Prove non-vacuity after it passes ([testing.md](testing.md)).
3. Implement the narrowest change that passes.
4. Run the gates relevant to the change, then the full suite before the PR.
5. If you touched the generator: `bun run docs` twice, confirm no diff.

Commits are imperative, with the ticket in parentheses when one applies:

```
feat: enforce authoritative parentage and name the trust model at boot (T-1204)
fix: bound and harden unread reconciliation after reconnect (T-1105)
docs: proxy exposure recipes with an external console origin contract (T-1202)
```

One logical change per commit. PR description: what changed and why, gates run, non-vacuity proof, anything unverified.

License is MIT ([ADR-010](../delivery/adr/ADR-010-mit-license.md)).
