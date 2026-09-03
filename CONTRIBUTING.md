# Contributing to oh-my-agent

Thanks for considering a contribution. This project runs autonomous agents with real
credentials against real accounts, so the bar for changes is deliberately concrete:
**every change carries evidence that it works.** This document tells you exactly what
that means and how to produce it.

## Table of contents

- [Ground rules](#ground-rules)
- [Getting set up](#getting-set-up)
- [The delivery tree](#the-delivery-tree)
- [Making a change](#making-a-change)
- [Testing standards](#testing-standards)
- [Commit and PR conventions](#commit-and-pr-conventions)
- [Where to start](#where-to-start)

## Ground rules

1. **Never hand-edit `docs/delivery/`.** It is generated. Author in
   [`scripts/gen-delivery-docs.py`](scripts/gen-delivery-docs.py) and run `bun run docs`.
   CI fails on drift.
2. **Tests call production builders.** A test that constructs its own copy of the thing
   it tests can pass while production drifts. Import the real function.
3. **No unverified claims.** If a doc says a mechanism enforces something, a test must
   demonstrate it. If evidence cannot be produced, say so plainly rather than implying
   it exists.

## Getting set up

Requirements: Bun ≥ 1.3.14 and [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` ≥ 18.0.7).

```sh
git clone https://github.com/bloodf/oh-my-agent.git
cd oh-my-agent
bun install
bun run typecheck   # tsc --noEmit
bun test            # full suite
bun run lint        # biome check .
```

The browser-console suite drives headless Chrome. If it cannot find one:

```sh
bunx @puppeteer/browsers install chrome-headless-shell --path "$HOME/.cache/puppeteer"
```

Working on something unrelated to packaging or the console? `bun run test:fast` skips
the three slowest suites (pack, consumer-install, console-client).

## The delivery tree

Every unit of work is a task file in [`docs/delivery/`](docs/delivery/README.md) with the
same nine headings in the same order: Goal, Read first, Files this task may change,
Modules and assets in play, Steps, Acceptance, Out of scope, Depends on, Unblocks.

Two files are worth reading before your first change:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — what the system is and why.
- [`docs/delivery/adr/`](docs/delivery/adr/) — decisions with the alternatives that lost
  and the evidence behind them. If your change contradicts an ADR, the ADR is part of
  the change.

`bun run docs` regenerates the tree and runs 15 gates: broken links, missing evidence
paths, status consistency, dependency cycles, and more. All must print `(expect 0)`.

## Making a change

For anything beyond a typo:

1. **Find or add the task.** Small fixes can reference an existing task. New behavior
   gets a new task entry in the generator, including which files it may change.
2. **Write the test first, and watch it fail.** See below.
3. **Implement the narrowest change that passes.**
4. **Run the gates** relevant to your change, then the full suite before opening a PR.
5. **Regenerate the docs** if you touched the generator: `bun run docs`, twice, and
   confirm the second run produces no diff.

## Testing standards

Two rules distinguish this project from most:

**Non-vacuity proof.** A green test is only evidence if it would go red without the fix.
After a test passes, revert the specific production line it covers, confirm that exact
test fails, then restore it. Mention the proof in your PR. This catches tests that
assert something already true, which are worse than no test because they look like
coverage.

**No fixed sleeps.** Wait on observable state with a deadline-bounded poll, never
`sleep(200)`. A timing test that passes on your laptop and fails on a loaded CI runner
is a flake you have handed to everyone else.

Beyond that: deterministic, isolated, safe to run in the full suite in any order. Tests
that spawn processes must clean them up in a `finally`, including on timeout.

## Commit and PR conventions

Commits are imperative and explain the change, with the ticket in parentheses when one
applies:

```
feat: enforce authoritative parentage and name the trust model at boot (T-1204)
fix: bound and harden unread reconciliation after reconnect (T-1105)
docs: proxy exposure recipes with an external console origin contract (T-1202)
```

One logical change per commit. In your PR description, state:

- What changed and why.
- The gates you ran and their results.
- Your non-vacuity proof for any new test.
- Anything you could not verify, and why.

That last point matters more than it looks. "I could not test the tailnet path because
I have no tailnet" is a useful, welcome sentence. A silent gap is not.

## Where to start

- [`docs/delivery/README.md`](docs/delivery/README.md) lists every task with its status.
  Anything marked **Ready** is specified and unblocked, and each task file names the
  files it may change — which makes the scope of the work obvious before you start.
- Five tasks are **Blocked** on things outside the repo (real-proxy evidence, a
  live-account session, two upstream releases). Each names its blocker in its
  `Out of scope` section. If you have the infrastructure one of them needs, that is
  genuinely valuable help.
- Found a bug? Open an issue with the reproduction; if it is a security issue, follow
  [`SECURITY.md`](SECURITY.md) instead.

Questions are welcome as issues. A question that reveals the docs were unclear is a bug
report about the docs.
