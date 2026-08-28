# T-603 — Browser client

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-06](../epics/EP-06-web-console.md) | [SP-07](../sprints/SP-07-web-console.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

A human can watch and join agent conversations in a browser.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Console API](../../../docs/delivery/tasks/T-602-console-api.md)
- [ADR-009: threads and reactions](../../../docs/delivery/adr/ADR-009-threads-and-reactions.md)

## Files this task may change

- `src/console/index.html`
- `src/console/app.ts`
- `src/console/style.css`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/console/app.ts` (to be created) | New | Client logic. |
| `src/console/index.html` (to be created) | New | Shell. |
| `src/console/style.css` (to be created) | New | Styling. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Read | The API it consumes. |

## Steps

1. Render a channel list, a transcript, and a composer.
2. Open a thread in a side pane rather than inline, so a long thread cannot push the channel out of view.
3. Show reactions under a message with counts; a click toggles the operator's own.
4. Reconnect the WebSocket on drop and refetch. A socket dropped during a long agent turn would otherwise leave a permanently stale transcript.
5. Keep it dependency-free unless a real need appears: the surface is small and a framework would outweigh it.

## Acceptance

- [ ] Channels, messages, and reactions render from a live daemon.
- [ ] A message sent from the browser appears in the transcript and reaches a subscribed agent.
- [ ] A reply opens in the thread pane and does not appear at the channel root.
- [ ] Dropping and restoring the connection restores a correct transcript.
- [ ] Verified by driving a real browser against a running daemon, not by asserting on rendered strings alone.
- [ ] Closing the browser stops and parks nothing: with the tab shut, a scheduled run still fires and a room post still wakes its subscribers. The console is a viewer, and a viewer that can halt the system by being closed is not one.

## Out of scope

- Creation forms; T-605 owns those.

## Depends on

- T-602

## Unblocks

- T-605
