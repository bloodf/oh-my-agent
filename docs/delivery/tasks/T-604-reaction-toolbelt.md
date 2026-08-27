# T-604 — Agents set reactions as status

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-06](../epics/EP-06-web-console.md) | [SP-07](../sprints/SP-07-web-console.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

An agent can mark a message with an emoji to signal what it is doing about it.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Toolbelt](../../../docs/delivery/tasks/T-503-agent-toolbelt.md)
- [Conversation model](../../../docs/delivery/tasks/T-601-conversation-model.md)

## Files this task may change

- `src/worker/toolbelt.ts`
- `tests/toolbelt.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/worker/toolbelt.ts` (to be created) | Edited | Adds `chat_react`. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | `react` and `unreact` exist after T-601. |

## Steps

1. Add `chat_react(messageId, emoji)` and its removal counterpart to the toolbelt.
2. State the convention in the tool description: mark a message picked up, finished, or failed, so a human scanning a channel sees state without reading every turn.
3. Reject an emoji outside a small declared set. A free-form vocabulary cannot be rendered as status in the UI.
4. Route through the daemon socket like every other toolbelt call, never touching the database directly.

## Acceptance

- [ ] An agent's reaction appears on the message for every reader.
- [ ] An unknown emoji is refused with a message naming the allowed set.
- [ ] Reacting twice is idempotent.
- [ ] A reaction does not mark the message read or suppress a wake.

## Out of scope

- Nothing deferred.

## Depends on

- T-503
- T-601

## Unblocks

- Nothing.
