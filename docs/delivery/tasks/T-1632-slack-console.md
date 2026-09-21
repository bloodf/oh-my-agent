# T-1632 — A Slack-faithful console

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

The bundled console looks and behaves like Slack desktop: gradient workspace chrome with a labeled rail and a filterable sidebar, a channel header with member stack and underline tabs, messages with hover actions, reaction pills from a full emoji picker, thread summary rows and date pills, a composer with a formatting row, a fluid layout with resizable sidebar and thread, curated sidebar themes, full agent settings in the browser, and image avatars for everyone. Behavior, keyboard access, and element ids stay as they were.

## Read first

- [The visual system](../../../web/DESIGN.md)
- [The console shell](../../../web/src/console/ConsoleShell.tsx)
- [The definition PATCH the settings dialog uses](../../../src/daemon/console-api.ts)
- [The browser suite that pins the DOM](../../../tests/console-client.test.ts)

## Files this task may change

- `web/src/lib/themes.ts`
- `web/src/lib/markdown-format.ts`
- `web/src/lib/panel-size.ts`
- `web/src/console/EmojiPicker.tsx`
- `web/src/console/definition/model.ts`
- `web/src/console/definition/fields.tsx`
- `web/src/console/definition/identity-sections.tsx`
- `web/src/console/definition/policy-sections.tsx`
- `web/src/console/definition/AvatarEditor.tsx`
- `tests/markdown-format.test.ts`
- `tests/panel-size.test.ts`
- `tests/profile.test.ts`
- `tests/definition-patch.test.ts`
- `web/src/lib/theme.ts`
- `web/src/index.css`
- `web/src/console/ThemeSelector.tsx`
- `web/src/console/WorkspaceToolbar.tsx`
- `web/src/console/ChannelRail.tsx`
- `web/src/console/ConsoleShell.tsx`
- `web/src/console/Transcript.tsx`
- `web/src/console/Message.tsx`
- `web/src/console/ThreadPanel.tsx`
- `web/src/console/Composer.tsx`
- `web/src/console/Markdown.tsx`
- `web/src/console/AgentPanel.tsx`
- `web/src/console/DefinitionDialog.tsx`
- `web/src/console/SchedulesTab.tsx`
- `web/src/console/ProfileDialog.tsx`
- `web/src/console/profile.ts`
- `web/src/console/CreateAgentDialog.tsx`
- `web/src/console/ChangesView.tsx`
- `web/src/console/PlansView.tsx`
- `web/src/console/Storybook.tsx`
- `web/package.json`
- `web/vite.config.ts`
- `web/DESIGN.md`
- `src/worker/toolbelt.ts`
- `src/daemon/profile.ts`
- `tests/toolbelt.test.ts`
- `tests/console-client.test.ts`
- `src/console/app.js`
- `src/console/style.css`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`web/src/lib/themes.ts`](../../../web/src/lib/themes.ts) | New | Six curated sidebar themes after Slack's; each sets only the --ws-* chrome variables. |
| [`web/src/lib/markdown-format.ts`](../../../web/src/lib/markdown-format.ts) | New | Pure helpers that wrap or insert Markdown at a textarea selection for the composer's formatting row. |
| [`web/src/lib/panel-size.ts`](../../../web/src/lib/panel-size.ts) | New | Clamps and persists the resizable sidebar and thread widths, and decides when the thread docks. |
| [`web/src/console/EmojiPicker.tsx`](../../../web/src/console/EmojiPicker.tsx) | New | The full emoji picker, loaded as a lazy chunk with bundled data; used for reactions and the composer. |
| [`web/src/console/definition/model.ts`](../../../web/src/console/definition/model.ts) | New | Builds the definition PATCH from a draft: only changed fields, with the account ceiling carried forward and never edited. |
| [`web/src/console/definition/fields.tsx`](../../../web/src/console/definition/fields.tsx) | New | Shared form controls for the agent settings sections. |
| [`web/src/console/definition/identity-sections.tsx`](../../../web/src/console/definition/identity-sections.tsx) | New | Soul with Markdown preview, profile, model, and rooms and hierarchy sections. |
| [`web/src/console/definition/policy-sections.tsx`](../../../web/src/console/definition/policy-sections.tsx) | New | Wake and autonomy, schedules and automations, and sandbox and tools sections. |
| [`web/src/console/definition/AvatarEditor.tsx`](../../../web/src/console/definition/AvatarEditor.tsx) | New | Emoji or image avatar editor that downscales uploads to 256 pixels before saving. |
| [`tests/markdown-format.test.ts`](../../../tests/markdown-format.test.ts) | New | Wrapping, toggling, and insertion at a selection. |
| [`tests/panel-size.test.ts`](../../../tests/panel-size.test.ts) | New | Width bounds, percentage caps, the channel minimum, the dock threshold, and storage failures. |
| [`tests/profile.test.ts`](../../../tests/profile.test.ts) | New | Grapheme avatars, image avatars at and over the size cap, refused mime types and malformed base64. |
| [`tests/definition-patch.test.ts`](../../../tests/definition-patch.test.ts) | New | Only changed fields are sent, and the account ceiling is carried forward and never changed. |
| [`web/src/lib/theme.ts`](../../../web/src/lib/theme.ts) | Edited | Applies the curated theme's chrome variables; a stored id from the old catalog falls back to Aubergine. |
| [`web/src/index.css`](../../../web/src/index.css) | Edited | Slack light and dark content tokens that keep AAA text contrast, chrome gradients, and component classes. |
| [`web/src/console/ThemeSelector.tsx`](../../../web/src/console/ThemeSelector.tsx) | Edited | Theme cards drawn as miniature workspaces beside the light, dark, and system modes. |
| [`web/src/console/WorkspaceToolbar.tsx`](../../../web/src/console/WorkspaceToolbar.tsx) | Edited | Gradient toolbar with centered search, the labeled icon rail, and avatar tiles that draw image avatars. |
| [`web/src/console/ChannelRail.tsx`](../../../web/src/console/ChannelRail.tsx) | Edited | Gradient sidebar with a conversation filter, unread badges, presence dots, and a resize handle. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | Channel header with member stack, underline tabs with the working-directory chip, fluid rows, and the search palette. |
| [`web/src/console/Transcript.tsx`](../../../web/src/console/Transcript.tsx) | Edited | Date pills between days. |
| [`web/src/console/Message.tsx`](../../../web/src/console/Message.tsx) | Edited | Hover action toolbar, reaction pills with the full picker, thread summary rows, and image avatars. |
| [`web/src/console/ThreadPanel.tsx`](../../../web/src/console/ThreadPanel.tsx) | Edited | Resizable docked panel that becomes an overlay when the channel column would drop under 480 pixels. |
| [`web/src/console/Composer.tsx`](../../../web/src/console/Composer.tsx) | Edited | Bordered box with a Markdown formatting row, emoji and mention actions, and the green send button. |
| [`web/src/console/Markdown.tsx`](../../../web/src/console/Markdown.tsx) | Edited | Slack code, list, link, and mention styling. |
| [`web/src/console/AgentPanel.tsx`](../../../web/src/console/AgentPanel.tsx) | Edited | Members, Operations, and Schedules; the account-ceiling tab is gone and each agent opens full settings. |
| [`web/src/console/DefinitionDialog.tsx`](../../../web/src/console/DefinitionDialog.tsx) | Edited | Sectioned agent settings over the existing definition PATCH, keeping the raw JSON editor as Advanced. |
| [`web/src/console/SchedulesTab.tsx`](../../../web/src/console/SchedulesTab.tsx) | Edited | Scrolls inside the sheet, never clips its buttons, and adds a schedule without replacing the others. |
| [`web/src/console/ProfileDialog.tsx`](../../../web/src/console/ProfileDialog.tsx) | Edited | Emoji or image avatars for the operator and every agent; sends only changed personas. |
| [`web/src/console/profile.ts`](../../../web/src/console/profile.ts) | Edited | Recognizes image avatars. |
| [`web/src/console/CreateAgentDialog.tsx`](../../../web/src/console/CreateAgentDialog.tsx) | Edited | Avatar at creation; no account ceiling field. |
| [`web/src/console/ChangesView.tsx`](../../../web/src/console/ChangesView.tsx) | Edited | Fluid grid and a diff viewer that scrolls long lines inside itself. |
| [`web/src/console/PlansView.tsx`](../../../web/src/console/PlansView.tsx) | Edited | Fluid card grid. |
| [`web/src/console/Storybook.tsx`](../../../web/src/console/Storybook.tsx) | Edited | Stories follow the new shell, with richer definition and profile fixtures. |
| [`web/package.json`](../../../web/package.json) | Edited | emoji-mart and its data, pinned. |
| [`web/vite.config.ts`](../../../web/vite.config.ts) | Edited | The HTML rewrite runs only for builds, so the dev server loads the source entry. |
| [`web/DESIGN.md`](../../../web/DESIGN.md) | Edited | The Slack visual system and curated themes. |
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | Agents may react with any single emoji instead of four. |
| [`src/daemon/profile.ts`](../../../src/daemon/profile.ts) | Edited | Avatars may be small data-URL images as well as up to four characters. |
| [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) | Edited | Any single emoji accepted; letters, pairs, and shortcodes refused. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Appearance picks a curated theme; the removed ceiling tab's test is gone; the definition editor opens on the soul. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Regenerated from web/. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Regenerated from web/. |

## Steps

1. Replace the generated palettes with Slack content tokens that keep AAA contrast and curated chrome themes.
2. Rebuild the chrome, conversation, and overlays against those tokens without moving any id the browser suite reads.
3. Make the layout fluid: resizable sidebar and thread, a thread that docks only when the channel keeps its width, and views that scroll inside themselves.
4. Give the browser the rest of an agent: sectioned settings over the existing PATCH, any emoji for reactions from people and agents, and image avatars; drop the account ceiling from the console.

## Acceptance

- [x] The console browser suite passes against the rebuilt console, including the AAA contrast, reduced-motion, keyboard, and 320/390-pixel journeys.
- [x] No page overflows horizontally from 320 to 2560 pixels wide in any story, and the sidebar and thread widths clamp and persist.
- [x] An agent can react with any single emoji and is refused for letters, pairs, and shortcodes.
- [x] An avatar is up to four characters or a PNG, JPEG, WebP, or GIF data URL of at most 200 KB, and anything else is refused.
- [x] A definition edit sends only changed fields and never changes an account ceiling.

Evidence:

| Claim | Anchor |
|---|---|
| 72 of 72 browser tests pass against the rebuilt console on 2026-09-14 | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
| Width clamps and persistence | [`tests/panel-size.test.ts`](../../../tests/panel-size.test.ts) |
| Image avatar validation | [`tests/profile.test.ts`](../../../tests/profile.test.ts) |
| Changed-field patches that carry the ceiling forward | [`tests/definition-patch.test.ts`](../../../tests/definition-patch.test.ts) |
| Any single emoji for agents | [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) |
| Formatting-row insertion | [`tests/markdown-format.test.ts`](../../../tests/markdown-format.test.ts) |

## Out of scope

- Account ceilings: the daemon, the CLI bump, and quota parking are unchanged; the console no longer edits them. A webfont: the console keeps system fonts. The server-rendered console in web-next/.

## Depends on

- T-1631

## Unblocks

- T-1633
