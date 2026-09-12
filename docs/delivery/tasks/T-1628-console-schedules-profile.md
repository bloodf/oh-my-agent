# T-1628 — Schedules and a display profile in the console

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

An operator sees every schedule and heartbeat in the console with its next fire, pauses or resumes each, adds a cron schedule to an agent, and sets a display name and avatar for themselves and for each agent that every console then shows.

## Read first

- [The console API's options and routes](../../../src/daemon/console-api.ts)
- [The agent sheet the tab joins](../../../web/src/console/AgentPanel.tsx)
- [How the transcript draws an author](../../../web/src/console/Message.tsx)

## Files this task may change

- `src/daemon/profile.ts`
- `src/daemon/console-api.ts`
- `src/daemon/runtime.ts`
- `web/src/console/profile.ts`
- `web/src/console/ProfileDialog.tsx`
- `web/src/console/SchedulesTab.tsx`
- `web/src/console/AgentPanel.tsx`
- `web/src/console/ConsoleShell.tsx`
- `web/src/console/WorkspaceToolbar.tsx`
- `web/src/console/Message.tsx`
- `web/src/console/useConsole.ts`
- `web/src/console/Storybook.tsx`
- `web/src/lib/types.ts`
- `src/console/app.js`
- `src/console/style.css`
- `tests/console-api.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/profile.ts`](../../../src/daemon/profile.ts) | New | The display profile store: validated personas for the operator and per agent, written atomically under the state dir. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | GET /api/schedules, PATCH /api/schedules/:id, GET/PUT /api/profile, and a profile frame. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | Hands the console its schedule map, armSchedule, and a profile store. |
| [`web/src/console/profile.ts`](../../../web/src/console/profile.ts) | New | The profile context and personaFor: a wire author to its display name and avatar. |
| [`web/src/console/ProfileDialog.tsx`](../../../web/src/console/ProfileDialog.tsx) | New | Edit the operator's and each agent's display name and avatar; saved through PUT /api/profile. |
| [`web/src/console/SchedulesTab.tsx`](../../../web/src/console/SchedulesTab.tsx) | New | List with next fire and switch; a form that appends a cron schedule to an agent's definition. |
| [`web/src/console/AgentPanel.tsx`](../../../web/src/console/AgentPanel.tsx) | Edited | A Schedules tab. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | Provides the profile context and mounts the dialog. |
| [`web/src/console/WorkspaceToolbar.tsx`](../../../web/src/console/WorkspaceToolbar.tsx) | Edited | A Profile and avatars button. |
| [`web/src/console/Message.tsx`](../../../web/src/console/Message.tsx) | Edited | Author and avatar drawn from the profile. |
| [`web/src/console/useConsole.ts`](../../../web/src/console/useConsole.ts) | Edited | Loads the profile on connect and on its frame. |
| [`web/src/console/Storybook.tsx`](../../../web/src/console/Storybook.tsx) | Edited | Fixtures for both routes. |
| [`web/src/lib/types.ts`](../../../web/src/lib/types.ts) | Edited | The profile frame. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Rebuilt. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Rebuilt. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Schedules list and flip; profile validation, persistence, and frame. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | The dialog renames the operator and an agent and survives a reload; the tab pauses a heartbeat. |

## Steps

1. Expose the daemon's schedule map and arm switch to the console over two routes, gated like membership.
2. Keep the profile cosmetic: a validated JSON file the console reads, never an author on the wire.
3. Resolve every drawn author through one context so the transcript, threads, and the dialog agree.

## Acceptance

- [x] The schedules tab lists a heartbeat and pausing it flips the daemon's record.
- [x] Saving a display name renames the operator and the agent in the transcript and survives a reload.
- [x] A field over its length, an unknown field, or a bad agent name is refused with a 400 and nothing is written.

Evidence:

| Claim | Anchor |
|---|---|
| Schedule routes and profile validation, persistence, and frame | [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) |
| The profile dialog and the schedules tab in the browser | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Editing an existing schedule's cron in place: the definition editor already carries the schedules field for that.

## Depends on

- T-1627

## Unblocks

- Nothing.
