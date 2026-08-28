# T-503 — Worker toolbelt extension

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

A worker can talk to rooms and peers through tools injected into its own session.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Room store](../../../src/rooms/store.ts)
- [Spawn classification](../../../src/worker/lifecycle.ts)
- [Control protocol](../../../docs/delivery/tasks/T-507-control-socket-protocol.md)

## Files this task may change

- `src/worker/toolbelt.ts`
- `tests/toolbelt.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/worker/toolbelt.ts` (to be created) | New | `chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`. |
| `tests/toolbelt.test.ts` (to be created) | New | Tool behavior against a running daemon socket. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Read | The method set these tools call; do not invent a second one. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | Backing bus. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Read | `classifyAgentSpawn` already exists; reuse it. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Read | Transport to the daemon. |

## Steps

1. Expose the toolbelt as an OMP extension loaded into each worker session.
2. Route every call over the daemon control socket using the T-507 client types, so the worker never touches the room database directly and cannot corrupt a shared writer.
3. Implement `chat_wait` as a blocking wait the daemon satisfies on a wake, rather than a poll loop that burns turns. What counts as a wake is T-509's semantics: a mention the peer opted into, or a post in a room it subscribes to, never its own post.
4. Route `agent_spawn` through `classifyAgentSpawn` and reject a coding subtask with a message naming `task` as the correct tool.
5. Keep the tool list additive: never emit an explicit `tools:` list that would strip native `task`.

## Acceptance

- [ ] `chat_send` posts and the message is visible to a subscribed peer.
- [ ] `chat_wait` blocks and returns on a wake as T-509 defines it, and does not return on a post the peer would not be woken by.
- [ ] `agent_spawn` with a coding-subtask payload is refused and names `task`.
- [ ] A worker with the toolbelt still exposes native `task` in its effective tool list.
- [ ] Every call goes over the socket: the suite fails if the toolbelt opens the room database itself.

## Out of scope

- New room semantics; T-402 owns the store.
- Wake filtering itself, which T-509 implements in the supervisor.

## Depends on

- T-502
- T-507

## Unblocks

- T-604
