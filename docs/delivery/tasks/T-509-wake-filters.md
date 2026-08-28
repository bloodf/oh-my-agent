# T-509 — Wake filters and mention parsing

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The parsed `wake:` configuration actually governs who a message wakes.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Supervisor](../../../src/daemon/supervisor.ts)
- [Parser](../../../src/shared/agent-definition.ts)

## Files this task may change

- `src/daemon/supervisor.ts`
- `src/rooms/store.ts`
- `tests/supervisor.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Consume `wake.mention` and `wake.rooms` in the delivery path. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Edited | Expose mentions alongside message text so delivery does not re-parse bodies. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | Mention and subscription wake cases; T-405 owns the file. |
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | Read | `wake: {mention, rooms}` already parses; nothing reads it yet. |

## Steps

1. Consume the already-parsed `wake: {mention, rooms}` in delivery. The parser has produced this since T-101 and nothing has ever read it, which means a documented, validated, tested configuration key currently does nothing at all.
2. Parse `@name` mentions once, at post time, and carry them with the message rather than re-scanning every body per subscriber on every delivery.
3. Wake a peer on a mention only when its `wake.mention` is true, so opting out is real rather than advisory.
4. Wake on a room post only for peers subscribed to that room, which is existing behavior and must stay: keep it as a regression test rather than reimplementing it.
5. Never wake a peer on its own post. This is already covered and stays covered; the test moves under this task's ownership rather than being written twice.

## Acceptance

- [ ] `@name` in a body wakes that peer when `wake.mention` is true, and does not when it is false.
- [ ] A room post wakes only that room's subscribers.
- [ ] A peer's own post never wakes it, proven by the existing regression continuing to pass.
- [ ] A mention of an unknown name wakes nobody and is not an error.
- [ ] Mentions are parsed once per post, not once per subscriber, asserted by the parse being observable exactly once.

## Out of scope

- Reaction-based wakes; ADR-009 keeps a reaction from marking anything read.
- The toolbelt's `chat_wait`, which consumes these semantics but is T-503.

## Depends on

- T-405

## Unblocks

- Nothing.
