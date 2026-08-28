# T-513 — Reaction methods on the control socket

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The daemon serves `chat_react` and `chat_unreact`, so the T-604 toolbelt works in production instead of returning method-not-found.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Control protocol](../../../src/shared/protocol.ts)
- [Socket server](../../../src/daemon/socket.ts)
- [Toolbelt](../../../src/worker/toolbelt.ts)
- [ADR-009: threads and reactions](../../../docs/delivery/adr/ADR-009-threads-and-reactions.md)

## Files this task may change

- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `tests/protocol.contract.test.ts`
- `tests/daemon-main.test.ts`
- `tests/toolbelt.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | Adds `chat_react`/`chat_unreact`; wire RoomMessage gains the T-601 fields (parentId, threadRootId, replyCount, reactions) as optional, additive, no version bump (T-511's policy). |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Validators for both methods and the widened message shape. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Serves both methods through `RoomStore.react`/`unreact`; reactions ride chat_read/chat_wait results. |
| [`tests/protocol.contract.test.ts`](../../../tests/protocol.contract.test.ts) | Edited | The method set grows from thirteen; fixtures for both new methods. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | A react over the socket lands in the store and in chat_read output. |
| [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) | Edited | The fake-backed reaction tests migrate to the production handlers. |

## Steps

1. Follow the additive-no-bump policy already documented for T-511: new methods and optional result fields, no version change.
2. Serve react/unreact in the daemon by delegating to the store; the allowed-set refusal stays a toolbelt-local concern, and the daemon accepts what the store accepts.
3. Widen the wire RoomMessage so chat_read and chat_wait return the conversation model T-601 built; without it a reacting agent is invisible to every socket reader.
4. Migrate the toolbelt's reaction tests from the test-only backing to the production socket handlers, per ADR-008.

## Acceptance

- [ ] A toolbelt chat_react call against the real daemon lands on the message and is visible in chat_read.
- [ ] chat_unreact removes it; reacting twice leaves one reaction.
- [ ] The protocol contract suite names both methods in its exact set.
- [ ] The T-604 acceptance items pass against the production socket, which is what flips T-604 to Done.

## Out of scope

- Streaming reactions to the console; T-602's live feed already covers browser readers.

## Depends on

- T-507
- T-604

## Unblocks

- Nothing.
