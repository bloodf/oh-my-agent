# T-512 — Surface sandboxed state in agent_status

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The daemon reports which peers actually run under an OS sandbox, so the TUI shield (T-504, fail-closed) can ever appear.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Protocol types](../../../src/shared/protocol.ts)
- [Socket server](../../../src/daemon/socket.ts)
- [ADR-005: sandbox opt-in, fail closed](../../../docs/delivery/adr/ADR-005-sandbox-opt-in-fail-closed.md)

## Files this task may change

- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `tests/daemon-main.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | `AgentStatus.sandboxed?: boolean` — optional, additive, no version bump (T-511's policy). |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | Accept the optional boolean. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | `toAgentStatus` emits it from `WorkerHandle.sandboxed`. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | One sandboxed and one unsandboxed peer, asserted on the wire. |

## Steps

1. Add the optional field to the type and the validators; an absent field must remain valid, because older workers predate it.
2. Emit `WorkerHandle.sandboxed` (it already exists on the handle) in the daemon's status mapping — never infer it from `workspace:` scoping, which is not a sandbox (ADR-005).
3. Assert one sandboxed and one unsandboxed peer over the real socket in the daemon suite.

## Acceptance

- [ ] A sandboxed peer's status arrives with `sandboxed: true`; an unsandboxed peer arrives without it or with `false`.
- [ ] The protocol suite accepts both shapes.
- [ ] The extension's shield test (already landed) needs no change to pass against the production server.

## Out of scope

- Changing which peers are sandboxed — that is definition-level (`sandbox: true`), already shipped in EP-02.

## Depends on

- T-502

## Unblocks

- Nothing.
