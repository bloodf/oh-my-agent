# T-401 — RPC worker lifecycle

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-04](../epics/EP-04-autonomy-runtime.md) | [SP-04](../sprints/SP-04-autonomy.md) | Done | [asset-map](../asset-map.md) |

## Goal

A peer runs as a supervised child process that parks, resumes, and delegates through native `task`.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Spawn policy contract](../../../tests/contracts/spawn-policy.contract.test.ts)

## Files this task may change

- `src/worker/lifecycle.ts`
- `tests/worker-lifecycle.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | New | Start, park, resume, classify. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Read | Supplies the layout. |
| [`src/worker/launch-gate.ts`](../../../src/worker/launch-gate.ts) | Read | Gates opted-in peers. |
| [`tests/worker-lifecycle.test.ts`](../../../tests/worker-lifecycle.test.ts) | New | 22 tests. |

## Steps

1. Drive the child with OMP's `RpcClient`; deliver turns with `promptAndWait`, since `prompt()` returns immediately.
2. Pass the definition through `PI_CODING_AGENT_DIR` and its body via `--append-system-prompt`, because no `--agent` CLI flag exists.
3. Gate sandboxed peers inside `startWorker` itself, so no caller can supply a prebuilt plan and bypass the probe.
4. Park by stopping the child and keeping layout plus fingerprint; resume materializes fresh when the fingerprint moved.
5. Expose `sessionId` as identity rather than a pid, which `RpcClient` keeps private.
6. Classify `agent_spawn` payloads: durable peer versus coding subtask.

## Acceptance

- [x] A real child dispatches `task` and never `agent_spawn` for a coding subtask.
- [x] An opted-in peer with no adapter fails to start.
- [x] A parked worker holds no child process.
- [x] 22 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Lifecycle suite, 22 tests | [`tests/worker-lifecycle.test.ts`](../../../tests/worker-lifecycle.test.ts) |
| Commits | `e5855e1, 4117458` |

## Out of scope

- Nothing deferred.

## Depends on

- T-005
- T-201
- T-203
- T-301

## Unblocks

- T-405
