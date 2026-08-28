# T-504 — TUI commands, status widget, and dialogs

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A human can see and steer running agents from inside the OMP TUI.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Extension stub](../../../src/extension/index.ts)
- [Control protocol](../../../docs/delivery/tasks/T-507-control-socket-protocol.md)
- [ADR-005: sandbox opt-in, fail closed](../../../docs/delivery/adr/ADR-005-sandbox-opt-in-fail-closed.md)

## Files this task may change

- `src/extension/index.ts`
- `src/extension/commands.ts`
- `src/extension/widget.ts`
- `tests/extension.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | Currently a no-op factory. |
| `src/extension/commands.ts` (to be created) | New | `/agents`, `/rooms`, `/schedule`, `/spawn`, `/logs`, `/inject`. |
| `src/extension/widget.ts` (to be created) | New | Status line. |
| `tests/extension.test.ts` (to be created) | New | Command output and no-daemon degradation. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Read | The methods the commands call. |
| `src/daemon/socket.ts` (to be created) | Read | Data source. |

## Steps

1. Implement `/agents` listing name, state, account, and room subscriptions.
2. Show a shield only for peers actually running under an OS sandbox, never for `workspace:` scoping, because a shield on an unsandboxed agent is a false security claim.
3. Implement `/rooms` to read a transcript and post as `@you`.
4. Implement `/schedule` to list and arm schedules.
5. Implement `/spawn` to start a peer from a definition, `/logs --tail` to follow a worker's output, and inject-instructions to push a directive into a running session. §1 and §4.5 promise all three; leaving them out would ship a TUI that observes but cannot steer, which is half the point of the surface.
6. Add a status widget with running and parked counts plus unread totals.
7. Use ask-dialogs for destructive actions: killing a worker, bumping a metered budget.
8. Degrade to a clear message when no daemon is running, rather than throwing inside the TUI.

## Acceptance

- [ ] `/agents` lists peers with live state from the daemon.
- [ ] The shield appears only for sandboxed peers, verified against one sandboxed and one unsandboxed agent.
- [ ] `/rooms` posts as `@you` and the message wakes a subscribed peer.
- [ ] `/spawn` starts a peer that then appears in `/agents`; `/logs --tail` streams a running worker's output; injected instructions reach the live session's next turn.
- [ ] Killing a worker asks for confirmation first.
- [ ] With no daemon running, every command reports that clearly instead of raising.

## Out of scope

- Bus semantics and worker lifecycle, already covered by EP-04.

## Depends on

- T-502
- T-507

## Unblocks

- Nothing.
