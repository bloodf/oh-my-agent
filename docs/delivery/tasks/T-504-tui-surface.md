# T-504 — TUI commands, status widget, and dialogs

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A human can see and steer running agents from inside the OMP TUI.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Extension stub](../../../src/extension/index.ts)
- [Isolation layers](../../../ARCHITECTURE.md)

## Files this task may change

- `src/extension/index.ts`
- `src/extension/commands.ts`
- `src/extension/widget.ts`
- `tests/extension.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | Currently a no-op factory. |
| `src/extension/commands.ts` (to be created) | New | `/agents`, `/rooms`, `/schedule`. |
| `src/extension/widget.ts` (to be created) | New | Status line. |
| `src/daemon/socket.ts` (to be created) | Read | Data source. |

## Steps

1. Implement `/agents` listing name, state, account, and room subscriptions.
2. Show a shield only for peers actually running under an OS sandbox, never for `workspace:` scoping, because a shield on an unsandboxed agent is a false security claim.
3. Implement `/rooms` to read a transcript and post as `@you`.
4. Implement `/schedule` to list and arm schedules.
5. Add a status widget with running and parked counts plus unread totals.
6. Use ask-dialogs for destructive actions: killing a worker, bumping a metered budget.
7. Degrade to a clear message when no daemon is running, rather than throwing inside the TUI.

## Acceptance

- [ ] `/agents` lists peers with live state from the daemon.
- [ ] The shield appears only for sandboxed peers, verified against one sandboxed and one unsandboxed agent.
- [ ] `/rooms` posts as `@you` and the message wakes a subscribed peer.
- [ ] Killing a worker asks for confirmation first.
- [ ] With no daemon running, every command reports that clearly instead of raising.

## Out of scope

- Bus semantics and worker lifecycle, already covered by EP-04.

## Depends on

- T-502

## Unblocks

- Nothing.
