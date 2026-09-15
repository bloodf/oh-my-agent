# T-1805 — Plans keep edits on conflict and console views stop misbehaving

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-18](../epics/EP-18-review-2026-09.md) | [SP-19](../sprints/SP-19-review-fixes.md) | Done | [asset-map](../asset-map.md) |

## Goal

Refreshing a conflicted plan loads the server copy so a second save cannot overwrite another writer. The Changes view debounces and resets per room, an error boundary contains bad payloads, dialogs keep unsaved edits and report partial saves, remote consoles without full control lock policy fields, Storybook loads lazily, and its test renders every story in Chrome.

## Read first

- [The review findings Q-06, C-04, C-08 to C-14, C-19, C-21, C-23, C-27, C-28, Q-03, Q-04, and QS-01](../../../docs/develop/review-2026-09.md)
- [The plans view](../../../web/src/console/PlansView.tsx)

## Files this task may change

- `web/src/console/PlansView.tsx`
- `web/src/console/ChangesView.tsx`
- `web/src/console/ConsoleShell.tsx`
- `web/src/console/ErrorBoundary.tsx`
- `web/src/console/ViewTabs.tsx`
- `web/src/console/errors.ts`
- `web/src/console/ArtifactsView.tsx`
- `web/src/console/ProfileDialog.tsx`
- `web/src/console/CreateAgentDialog.tsx`
- `web/src/console/DefinitionDialog.tsx`
- `web/src/console/definition/identity-sections.tsx`
- `web/src/console/Composer.tsx`
- `web/src/console/AgentPanel.tsx`
- `web/src/console/WorkspaceToolbar.tsx`
- `web/src/console/ChannelRail.tsx`
- `web/src/console/Message.tsx`
- `web/src/console/Storybook.tsx`
- `web/src/App.tsx`
- `storybook/console/serve.ts`
- `storybook/console/stories.js`
- `tests/fixtures/chrome.ts`
- `tests/console-storybook.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`web/src/console/PlansView.tsx`](../../../web/src/console/PlansView.tsx) | Edited | Refresh loads the server copy; conflict by error code; a vanished plan disables Save. |
| [`web/src/console/ChangesView.tsx`](../../../web/src/console/ChangesView.tsx) | Edited | Debounced path, stale responses ignored, truncation notice. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | Per-room Changes path, picker cancel sends nothing, error boundary, scoped stopped banner, encoded chat ids. |
| [`web/src/console/ErrorBoundary.tsx`](../../../web/src/console/ErrorBoundary.tsx) | New | Recoverable fallback for a view that throws. |
| [`web/src/console/ViewTabs.tsx`](../../../web/src/console/ViewTabs.tsx) | New | Tabs shared by the shell and Storybook. |
| [`web/src/console/errors.ts`](../../../web/src/console/errors.ts) | New | Error text, error code check, and safe date formatting. |
| [`web/src/console/ArtifactsView.tsx`](../../../web/src/console/ArtifactsView.tsx) | Edited | Safe dates; Open review opens its window on the click. |
| [`web/src/console/ProfileDialog.tsx`](../../../web/src/console/ProfileDialog.tsx) | Edited | Draft seeded on open and kept across profile frames. |
| [`web/src/console/CreateAgentDialog.tsx`](../../../web/src/console/CreateAgentDialog.tsx) | Edited | Required fields marked and explained; remote create needs full control. |
| [`web/src/console/DefinitionDialog.tsx`](../../../web/src/console/DefinitionDialog.tsx) | Edited | Partial saves reported; policy sections locked remotely without full control. |
| [`web/src/console/definition/identity-sections.tsx`](../../../web/src/console/definition/identity-sections.tsx) | Edited | Tools and spawn rights locked remotely without full control. |
| [`web/src/console/Composer.tsx`](../../../web/src/console/Composer.tsx) | Edited | Read-only while sending, so focus and typed text survive. |
| [`web/src/console/AgentPanel.tsx`](../../../web/src/console/AgentPanel.tsx) | Edited | Instruction field has an id. |
| [`web/src/console/WorkspaceToolbar.tsx`](../../../web/src/console/WorkspaceToolbar.tsx) | Edited | Search name starts with its visible text. |
| [`web/src/console/ChannelRail.tsx`](../../../web/src/console/ChannelRail.tsx) | Edited | Workspace menu name starts with its visible text. |
| [`web/src/console/Message.tsx`](../../../web/src/console/Message.tsx) | Edited | Reaction pill names start with their visible text. |
| [`web/src/console/Storybook.tsx`](../../../web/src/console/Storybook.tsx) | Edited | Shares tabs with the shell. |
| [`web/src/App.tsx`](../../../web/src/App.tsx) | Edited | Storybook loaded lazily. |
| [`storybook/console/serve.ts`](../../../storybook/console/serve.ts) | Edited | Serves lazy chunks. |
| [`storybook/console/stories.js`](../../../storybook/console/stories.js) | Edited | Story fixtures for the new states. |
| [`tests/fixtures/chrome.ts`](../../../tests/fixtures/chrome.ts) | New | Shared headless Chrome launcher. |
| [`tests/console-storybook.test.ts`](../../../tests/console-storybook.test.ts) | Edited | Renders every story in Chrome and fails on page or console errors. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Plan conflict, Changes, Artifacts, error boundary, and chat panel tests on a daemon-served workspace harness. |

## Steps

1. Fix the plan conflict flow and cover it with two pages.
2. Fix each view defect with a browser test that fails without it.
3. Render Storybook stories in the suite.

## Acceptance

- [x] After a conflict and Refresh latest plan, saving keeps the other writer's edit visible and never silently overwrites it.
- [x] Typing a path in Changes sends one inspection after typing stops.
- [x] Every story renders in Chrome with no page or console errors.

Evidence:

| Claim | Anchor |
|---|---|
| Plan conflict and view tests | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
| Story render test | [`tests/console-storybook.test.ts`](../../../tests/console-storybook.test.ts) |

## Out of scope

- The Open review popup timing and the partial definition save are verified by reading, not by a browser test.

## Depends on

- T-1801

## Unblocks

- Nothing.
