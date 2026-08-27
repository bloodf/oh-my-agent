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

## Files this task may change

- `src/worker/toolbelt.ts`
- `tests/toolbelt.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/worker/toolbelt.ts` (to be created) | New | `chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | Backing bus. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Read | `classifyAgentSpawn` already exists; reuse it. |
| `src/daemon/socket.ts` (to be created) | Read | Transport to the daemon. |

## Steps

1. Expose the toolbelt as an OMP extension loaded into each worker session.
2. Route every call over the daemon control socket, so the worker never touches the room database directly and cannot corrupt a shared writer.
3. Implement `chat_wait` as a blocking wait the daemon can satisfy on a wake, rather than a poll loop that burns turns.
4. Route `agent_spawn` through `classifyAgentSpawn` and reject a coding subtask with a message naming `task` as the correct tool.
5. Keep the tool list additive: never emit an explicit `tools:` list that would strip native `task`.

## Acceptance

- [ ] `chat_send` posts and the message is visible to a subscribed peer.
- [ ] `chat_wait` blocks and returns when a matching message arrives.
- [ ] `agent_spawn` with a coding-subtask payload is refused and names `task`.
- [ ] A worker with the toolbelt still exposes native `task` in its effective tool list.

## Out of scope

- New room semantics; T-402 owns the store.

## Depends on

- T-502

## Unblocks

- Nothing.
