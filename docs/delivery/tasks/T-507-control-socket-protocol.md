# T-507 — Control-socket protocol

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Done | [asset-map](../asset-map.md) |

## Goal

The daemon's JSON-RPC-over-unix-socket contract exists as one typed, versioned artifact that every client and the server share.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Test harness](../../../tests/harness.test.ts)
- [ADR-001: RPC subprocess workers](../../../docs/delivery/adr/ADR-001-rpc-subprocess-workers.md)

## Files this task may change

- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `tests/protocol.contract.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | New | Method names, request and response types, protocol version. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | New | Runtime validation for every method's params and result. |
| [`tests/protocol.contract.test.ts`](../../../tests/protocol.contract.test.ts) | New | Pins the wire shape and the version field. |

## Steps

1. Declare the method set once: `status`, `chat_send`, `chat_read`, `chat_wait`, `agent_spawn`, `agent_status`, `task_handoff`, `rooms_list`, `rooms_post`, `schedules_list`, `schedules_arm`, `kill`, `bump`. Three consumers (daemon, toolbelt, TUI) are about to be written against this; a shape that lives only in the server is three shapes by the time they land.
2. Carry a `protocolVersion` from the first commit. Adding one later means a field that is absent on old peers and present on new ones, which is exactly the ambiguity a version exists to remove.
3. Validate params and results at the boundary rather than trusting the type system: types vanish at runtime, and the socket is where an unknown client reaches the daemon. Hand-roll the validation; this package carries no runtime dependencies and this task adds none.
4. Define the error shape too, including method-not-found, and make it carry the server's protocol version so a mismatched client learns why rather than guessing.
5. Keep the module free of transport and I/O. It is a contract; the moment it opens a socket it stops being shareable by both ends.

## Acceptance

- [x] Every declared method has a typed request, a typed response, and runtime validation on both.
- [x] An unknown method produces the declared method-not-found error carrying the protocol version.
- [x] A malformed params payload is refused at the boundary with the offending field named.
- [x] The contract module imports no transport and no daemon state.
- [x] Changing a method's shape fails the contract suite rather than surfacing as a runtime mismatch in T-502 or T-503.

Evidence:

| Claim | Anchor |
|---|---|
| Versioned contract artifact | [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) |
| Hand-rolled boundary validation | [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) |
| Contract suite, 14 tests | [`tests/protocol.contract.test.ts`](../../../tests/protocol.contract.test.ts) |

## Out of scope

- Serving the protocol, which is T-502.
- Consuming it from a worker, which is T-503.

## Depends on

- T-002

## Unblocks

- T-502
- T-503
- T-504
