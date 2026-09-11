# T-1623 — Channels from every surface, membership with history, invite by mention

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

An operator or a peer can create a channel and assign peers to it from the TUI, the shell, the console, or the toolbelt; a join is persisted and hands a running peer the room's whole history; and an @mention in a room the peer is not in invites it the same way instead of delivering one message.

## Read first

- [The supervisor's post, wake filters, and resubscribe](../../../src/daemon/supervisor.ts)
- [The console's membership route, the pattern this generalizes](../../../src/daemon/console-api.ts)
- [Subscriptions and pending delivery in the store](../../../src/rooms/store.ts)

## Files this task may change

- `src/daemon/supervisor.ts`
- `src/daemon/runtime.ts`
- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `src/daemon/startup.ts`
- `src/daemon/cli.ts`
- `src/extension/commands.ts`
- `src/extension/index.ts`
- `src/worker/toolbelt.ts`
- `src/defaults/agents/mate.md`
- `tests/supervisor.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | An invite seam: a mention from outside the peer's rooms persists the room, resubscribes live, and delivers the backlog. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | setMembership, the single writer for non-console membership edits; membership frames refresh the peer index. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | room_create, room_join, room_leave, additive. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Validators, with a room-id field check. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | The three handlers; create and join worker-callable. |
| [`src/daemon/startup.ts`](../../../src/daemon/startup.ts) | Edited | Usage lines. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | rooms create, join, leave. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | /rooms create, join, leave. |
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | The rooms dispatcher routes the new verbs. |
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | room_create and room_join tools. |
| [`src/defaults/agents/mate.md`](../../../src/defaults/agents/mate.md) | Edited | One channel per piece of work; brief the crew there. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | A mention from outside the peer's rooms invites it with the history. |

## Steps

1. Persist membership through one runtime seam and apply it to a live peer only through the supervisor's resubscribe.
2. Deliver after a live join: the subscription starts at cursor zero, so the next turn is the room's backlog.
3. In the supervisor's post, route a mention from outside the peer's rooms through the invite seam, falling back to the single-message delivery when persisting fails.

## Acceptance

- [x] room_join on a running peer answers live and delivered, its definition lists the room, and its next turn carries the backlog; on a stopped peer it answers not live and the definition still lists the room.
- [x] A mention in a room the peer left invites it back with the messages it missed.
- [x] The TUI and CLI verbs report what the daemon did and refuse a missing agent.

Evidence:

| Claim | Anchor |
|---|---|
| Invite by mention: persisted, live, with history | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |
| room_create, room_join with history, room_leave, invite over the real socket | [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) |
| rooms create, join, leave from the CLI | [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) |
| /rooms create, join, leave notices | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |

## Out of scope

- A console invite UI: posting there goes through the same supervisor path, so the behavior is already the same.

## Depends on

- T-1622

## Unblocks

- Nothing.
