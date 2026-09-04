# Developing oh-my-agent

Contributor hub. Operator install and usage live in the [root README](../../README.md). Ground rules and PR evidence live in [CONTRIBUTING.md](../../CONTRIBUTING.md). This tree is how you get a checkout green, find the right module, and land a change.

## First hour

1. Follow [setup.md](setup.md): clone, `bun install`, optional Chrome, first green run.
2. Confirm the suite is green (`bun run test:fast` while iterating; `bun test` before a PR).
3. Read [ARCHITECTURE.md §4](../../ARCHITECTURE.md#4-component-architecture) (component architecture). Then this folder's [architecture.md](architecture.md) for the onboarding tour.
4. Skim [modules.md](modules.md) so file names map to jobs.
5. Open the [delivery tree](../delivery/README.md). Nothing is **Ready**. Remaining work is **Blocked** (T-1202, T-1205, T-1403, T-1503, T-1504). File a bug, or add a task in [`scripts/gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py). Those tickets still want help if you have the missing piece. See [delivery.md](delivery.md).

## Pages

| Page | Use it for |
|---|---|
| [setup.md](setup.md) | Clone, install, Chrome, first green run, Biome |
| [architecture.md](architecture.md) | How TUI, CLI, and console reach the daemon |
| [modules.md](modules.md) | File-to-purpose map of `src/` and `tests/` |
| [testing.md](testing.md) | How to run and write tests, non-vacuity, flake rules |
| [delivery.md](delivery.md) | Picking a task, adding a task, regenerating the tree |

## Rules that bite

- **`docs/delivery/` is generated.** Author in [`scripts/gen-delivery-docs.py`](../../scripts/gen-delivery-docs.py). CI fails on drift. Never hand-edit the output.
- **Tests call production builders** ([ADR-008](../delivery/adr/ADR-008-tests-share-production-builders.md)). Import the real function.
- **Non-vacuity.** After a test passes, revert the production line it covers, watch that test fail, restore. Mention the proof in the PR.
- **No fixed sleeps.** Deadline-bounded poll. Spawn cleanup in `finally`.
- **Never commit tokens. Never log credential material.**
- **`workspace:` is not a security boundary.** Isolation layers: OS sandbox (opt-in, fail-closed), write isolation, convention scoping. See [architecture.md](architecture.md#isolation).

## Current tree

**95 of 100 tasks Done.** Five remain Blocked:

| Task | Blocker |
|---|---|
| [T-1202](../delivery/tasks/T-1202-tls-termination.md) | Real-proxy evidence (tailscale serve row unverified) |
| [T-1205](../delivery/tasks/T-1205-exposure-runbook.md) | Blocked on T-1202 |
| [T-1403](../delivery/tasks/T-1403-first-live-session.md) | Live-account session |
| [T-1503](../delivery/tasks/T-1503-drop-resolve-walk.md) | Released upstream fix |
| [T-1504](../delivery/tasks/T-1504-drop-rpc-pid-patch.md) | Released upstream `RpcClient.pid` |

Treat the delivery README as current. A pasted count here will rot.

## Spec vs tree

[ARCHITECTURE.md](../../ARCHITECTURE.md) is the design specification. Every section is marked Implemented, Partial, or Planned. Where it disagrees with `docs/delivery/`, the delivery tree wins.
