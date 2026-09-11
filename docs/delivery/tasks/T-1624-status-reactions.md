# T-1624 — Status reactions set by the daemon on delivery

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Every message delivered to a peer carries that peer's seen mark, a message addressed to it carries an in-progress mark while its turn runs and a done or failed mark when the turn ends, all set by the daemon so a model cannot forget them; a peer's own reactions layer on top.

## Read first

- [Delivery, the path the reactions wrap](../../../src/daemon/supervisor.ts)
- [The reaction set and its meaning](../../../docs/delivery/adr/ADR-009-threads-and-reactions.md)
- [The worker's chat_react tool](../../../src/worker/toolbelt.ts)

## Files this task may change

- `src/daemon/supervisor.ts`
- `src/worker/toolbelt.ts`
- `tests/supervisor.test.ts`
- `tests/toolbelt.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Around the prompt: seen on everything delivered, in-progress then done or failed on what is addressed; a failed write is reported, never blocking. |
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | chat_react guidance says what the daemon marks and when a peer's own reaction adds something. |
| [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) | Edited | Marks during and after a turn; a throwing turn leaves the failed mark. |
| [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) | Edited | Existing reaction tests see the daemon's delivery mark beside the worker's own. |

## Steps

1. In the supervisor's delivery, react on every delivered message before the prompt and on the addressed ones around it, from the same four emoji ADR-009 declared.
2. Report a failed reaction write through onError and continue: status must never block a turn.

## Acceptance

- [x] During a turn the addressed message shows seen and in-progress; after it, seen and done.
- [x] A turn that throws leaves seen and failed, and the error still surfaces.

Evidence:

| Claim | Anchor |
|---|---|
| Reactions during and after a turn; a failed turn | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |
| Worker reactions beside the daemon's marks | [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) |

## Out of scope

- New emoji: the set stays the four ADR-009 chose, so the console renders them as status.

## Depends on

- T-1623

## Unblocks

- Nothing.
