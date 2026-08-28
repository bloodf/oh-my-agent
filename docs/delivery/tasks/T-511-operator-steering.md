# T-511 — Operator steering: logs tail and instruction injection

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Done | [asset-map](../asset-map.md) |

## Goal

`/logs --tail` follows a running worker's output and an injected instruction reaches a live session's next turn — the steering half of the TUI that T-504 deferred because the protocol had no methods for it.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Control protocol](../../../src/shared/protocol.ts)
- [Socket server](../../../src/daemon/socket.ts)
- [TUI commands](../../../src/extension/commands.ts)

## Files this task may change

- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `src/extension/commands.ts`
- `tests/protocol.contract.test.ts`
- `tests/extension.test.ts`
- `tests/daemon-main.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | Adds `logs_tail` and `inject` method shapes. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Validators for both, on params and results. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | Serves both methods against live workers. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | The `/logs` and `/inject` verbs. |
| [`tests/protocol.contract.test.ts`](../../../tests/protocol.contract.test.ts) | Edited | The method set grows; the exact-set test must name the new methods. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | Verb coverage over the real socket. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | Method coverage against a stub worker. |

## Steps

1. Add the methods additively without bumping `protocolVersion`: an old daemon answers an unknown method with method-not-found carrying its version, which is the designed mismatch path, so additive growth does not need lockstep. Record that policy in the protocol module's header so the next addition follows it.
2. `logs_tail` params `{name, lines?}` return `{name, lines: string[]}` from the worker's buffered stderr/stdout (WorkerHandle exposes `stderr()`; size the buffer in the daemon, not per request).
3. `inject` params `{name, message}` queue the message into the worker's next turn — through `Supervisor.deliver` if the peer is parked, directly via `worker.prompt` when running — and return `{name, queued: boolean}`.
4. Wire both verbs in the TUI: `/logs <name> [--tail]` prints the buffer (tail follows), `/inject <name> <message>` confirms the queue.
5. Update the contract suite's exact method set and add validation fixtures for both methods, params and results.

## Acceptance

- [x] An old client calling `logs_tail` against this daemon gets a validated result; this daemon calling an unknown method still answers method-not-found with the version.
- [x] `/logs --tail` against a running stub worker streams its output in the extension suite.
- [x] An injected instruction reaches the worker's next prompt, proven against the daemon suite's stub worker prompts.
- [x] The protocol header documents the additive-no-bump policy.

Evidence:

| Claim | Anchor |
|---|---|
| Seventeen-method protocol with steering shapes | [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) |
| Steering verbs registered in the TUI | [`src/extension/index.ts`](../../../src/extension/index.ts) |
| Extension suite covers /logs and /inject over the real socket | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |

## Out of scope

- Streaming logs over a subscription (a method per call is enough at this size; SSE/websocket tailing belongs to the console API, T-602).

## Depends on

- T-502
- T-504

## Unblocks

- Nothing.
