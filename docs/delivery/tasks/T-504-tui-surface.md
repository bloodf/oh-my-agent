# T-504 — TUI commands, status widget, and dialogs

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Done | [asset-map](../asset-map.md) |

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
- `src/extension/ensure-daemon.ts`
- `tests/extension.test.ts`
- `tests/ensure-daemon.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | Currently a no-op factory. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | New | `/agents`, `/rooms`, `/schedule`, `/spawn`, `/kill`. Steering verbs (`/logs`, `/inject`) are T-511, which owns the protocol additions they need. |
| [`src/extension/widget.ts`](../../../src/extension/widget.ts) | New | Status line. |
| [`src/extension/ensure-daemon.ts`](../../../src/extension/ensure-daemon.ts) | New | Session-start auto-start of the detached daemon from the plugin tree, not PATH. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | New | Command output and no-daemon degradation. |
| [`tests/ensure-daemon.test.ts`](../../../tests/ensure-daemon.test.ts) | New | Probe no-op when up; spawn when down; injected spawn seam. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Read | The methods the commands call. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Read | Data source. |

## Steps

1. Implement `/agents` listing name, state, account, and room subscriptions.
2. Show a shield only for peers actually running under an OS sandbox, never for `workspace:` scoping, because a shield on an unsandboxed agent is a false security claim.
3. Implement `/rooms` to read a transcript and post as `@you`.
4. Implement `/schedule` to list and arm schedules.
5. Implement `/spawn` to start a peer from a definition. Steering verbs (`/logs --tail`, inject-instructions) need protocol methods T-507 froze without them; T-511 owns the protocol additions and the verbs together.
6. Add a status widget with running and parked counts plus unread totals.
7. Use ask-dialogs for destructive actions: killing a worker, bumping a metered budget.
8. Degrade to a clear message when no daemon is running, rather than throwing inside the TUI.

## Acceptance

- [x] `/agents` lists peers with live state from the daemon.
- [x] The shield appears only for sandboxed peers, verified against one sandboxed and one unsandboxed agent.
- [x] `/rooms` posts as `@you` and the message wakes a subscribed peer.
- [x] `/spawn` starts a peer that then appears in `/agents`. (Steering — `/logs --tail` and injected instructions reaching the live session's next turn — is T-511's acceptance, gated on its protocol additions.)
- [x] Killing a worker asks for confirmation first.
- [x] With no daemon running, every command reports that clearly instead of raising.

Evidence:

| Claim | Anchor |
|---|---|
| Command and widget surface | [`src/extension/commands.ts`](../../../src/extension/commands.ts) |
| Extension suite, 16 tests over the real socket | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |

## Out of scope

- Bus semantics and worker lifecycle, already covered by EP-04.

## Depends on

- T-502
- T-507

## Unblocks

- T-511
