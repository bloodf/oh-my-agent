# T-1617 — A stopped worker holds its backlog instead of failing the post

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Posting into a room whose member agent is stopped stores the message and reports success, exactly as it does for a parked member, rather than throwing an exception that surfaces as a 500 for work the room already accepted.

## Read first

- [Delivery path](../../../src/daemon/supervisor.ts)
- [The throw a stopped worker raises](../../../src/worker/lifecycle.ts)
- [The console handler that turns it into a 500](../../../src/daemon/console-api.ts)

## Files this task may change

- `src/daemon/supervisor.ts`
- `tests/supervisor.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Delivery returns early for a stopped worker, leaving the backlog pending for a later spawn. Parked is deliberately excluded, because waking a parked peer is what delivery is for. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | A post to a room with a stopped member delivers nothing, throws nothing, and leaves the message pending rather than acknowledged. |

## Steps

1. Reproduce in a browser: post to a channel whose only member is stopped, and watch the console return 500 while the room stores the message.
2. Return early from delivery when the worker is stopped, matching how a stale definition is held rather than thrown.
3. Assert the hold: nothing prompted, nothing thrown, and the message still pending for the next spawn.

## Acceptance

- [x] A post to a room whose member is stopped succeeds and is stored, with no 500 and no exception.
- [x] The message stays pending, so a later spawn delivers it rather than losing the turn.
- [x] A parked member is unaffected and is still woken and prompted.

Evidence:

| Claim | Anchor |
|---|---|
| Delivery holds the backlog for a stopped worker | [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) |
| The hold is proven, including that the message stays pending | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |

## Out of scope

- The console's blanket 500 mapping for genuinely unexpected errors, which is correct for errors that are actually unexpected.

## Depends on

- Nothing.

## Unblocks

- Nothing.
