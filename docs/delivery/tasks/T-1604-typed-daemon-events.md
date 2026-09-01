# T-1604 — Typed daemon state events

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

ADR-015 is implemented with typed agent, definition, membership, channel, budget, and schedule frames that refresh only the affected console panel.

## Read first

- [Typed event decision](../../../docs/delivery/adr/ADR-015-typed-daemon-events.md)
- [Reaction frame machinery](../../../docs/delivery/tasks/T-1602-reaction-removal-frames.md)
- [Daemon state owner](../../../src/daemon/supervisor.ts)
- [Schedule fire path](../../../src/daemon/main.ts)

## Files this task may change

- `src/daemon/console-api.ts`
- `src/console/app.js`
- `src/daemon/main.ts`
- `src/daemon/supervisor.ts`
- `tests/console-api.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Carries the additive frame taxonomy to connected consoles. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Validates frames and refreshes only their affected panels. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Emits schedule arm and fire transitions. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Emits agent, definition, membership, channel, budget, and schedule state transitions. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Asserts the schema of every typed frame. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proves targeted panel updates without manual refresh. |

## Steps

1. Extend T-1602's frame machinery with agent, definition, membership, channel, budget, and schedule schemas emitted where each transition commits.
2. Handle each frame by refreshing only its affected console panel; retain the socket-open snapshot as reconnect healing.
3. Cover spawn, kill, schedule arm/fire, budget park, and every frame schema in the API and browser suites.

## Acceptance

- [ ] Browser-proven: an agent spawn or kill updates the agents panel without a manual refresh; a schedule arm/fire and a budget park emit frames the client handles.
- [ ] Every frame type has a schema assertion.

## Out of scope

- Nothing deferred.

## Depends on

- T-1602

## Unblocks

- T-1605
