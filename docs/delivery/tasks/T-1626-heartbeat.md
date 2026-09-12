# T-1626 — A heartbeat so peers keep working without an orchestrator

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

A peer can declare a standing interval and receive a turn on it while running — read your rooms and plans, continue unfinished work, answer idle if nothing is pending — queued behind any turn in flight, listed and switchable beside the schedules, so a crew carries on with nobody waking it.

## Read first

- [How cron schedules are armed and disarmed](../../../src/daemon/runtime.ts)
- [Per-peer delivery serialization](../../../src/daemon/supervisor.ts)
- [The definition parser's extra keys](../../../src/shared/agent-definition.ts)

## Files this task may change

- `src/shared/duration.ts`
- `src/shared/agent-definition.ts`
- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/supervisor.ts`
- `src/daemon/runtime.ts`
- `src/daemon/presets.ts`
- `src/daemon/peer-store.ts`
- `src/daemon/console-api.ts`
- `src/defaults/agents/mate.md`
- `src/defaults/agents/staff-pm.md`
- `src/defaults/agents/staff-backend.md`
- `src/defaults/agents/staff-frontend.md`
- `src/defaults/agents/staff-qa.md`
- `tests/agent-definition.test.ts`
- `tests/supervisor.test.ts`
- `tests/daemon-main.test.ts`
- `tests/default-peers.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/duration.ts`](../../../src/shared/duration.ts) | New | Parses 90s, 30m, 2h, 1d into milliseconds; dependency-free. |
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | Edited | The heartbeat key: every (a duration of at least 10s) and an optional prompt; INVALID_HEARTBEAT. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | PresetInfo carries heartbeat. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | The same check on the wire. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | nudge: prompt a running peer through the per-peer queue; delivery and nudges share one serializer. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | armHeartbeat: a one-shot re-armed after each firing, listed as <peer>:heartbeat, disarmable and persisted like a schedule. |
| [`src/daemon/presets.ts`](../../../src/daemon/presets.ts) | Edited | A preset's heartbeat travels with it. |
| [`src/daemon/peer-store.ts`](../../../src/daemon/peer-store.ts) | Edited | heartbeat is a stored definition key. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | heartbeat is a wire definition field. |
| [`src/defaults/agents/mate.md`](../../../src/defaults/agents/mate.md) | Edited | every: 30m. |
| [`src/defaults/agents/staff-pm.md`](../../../src/defaults/agents/staff-pm.md) | Edited | every: 30m. |
| [`src/defaults/agents/staff-backend.md`](../../../src/defaults/agents/staff-backend.md) | Edited | every: 30m. |
| [`src/defaults/agents/staff-frontend.md`](../../../src/defaults/agents/staff-frontend.md) | Edited | every: 30m. |
| [`src/defaults/agents/staff-qa.md`](../../../src/defaults/agents/staff-qa.md) | Edited | every: 30m. |
| [`tests/agent-definition.test.ts`](../../../tests/agent-definition.test.ts) | Edited | A heartbeat parses; a short, malformed, or over-keyed one is refused. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | A nudge waits behind a turn in flight and skips a peer that is not running. |
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | Listed, fires into the worker, disarms, and stays disarmed across a restart. |
| [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) | Edited | The crew and every preset declare one. |

## Steps

1. Parse and validate the key once, in the definition parser, and mirror the check in the wire validator with a shared duration parser.
2. Deliver through the supervisor's serializer so a heartbeat never lands mid-turn, and only to a running peer.
3. Arm it as a re-arming one-shot under the schedule id, so the existing list and arm surfaces cover it.

## Acceptance

- [x] A peer with heartbeat every 10s receives the prompt within 15s of boot and its schedule row shows the next fire.
- [x] Disarming clears the next fire and survives a restart.
- [x] A nudge issued during a turn runs after it; a parked peer is not nudged.

Evidence:

| Claim | Anchor |
|---|---|
| Heartbeat parses and is refused when malformed | [`tests/agent-definition.test.ts`](../../../tests/agent-definition.test.ts) |
| Nudge serialization and gating | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |
| Listed, fired, disarmed, persisted | [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) |
| Crew and presets declare it | [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) |

## Out of scope

- A heartbeat that resumes a quota-parked peer: the block is the registry's decision, and delivery respects it the same way.

## Depends on

- T-1625

## Unblocks

- Nothing.
