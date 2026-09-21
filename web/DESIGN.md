# OMP conversation workspace

## Product and decisions

A local-first web interface to OMP: independent chats launched in a selected workspace, persistent agent DMs, and shared rooms. The conversation is the primary surface, not a dashboard widget. Operator approved real creation dialogs, rooms-first navigation, live repository changes, durable plans, and explicit remote full-control opt-in.

Independent chats run native OMP RPC subprocesses with cwd set to the selected folder and normal operator configuration discovery. They are not registered persistent agents. Model catalogs come from that session; model choice is per chat. Existing peer isolation remains unchanged.

Independent chat metadata and native session files live only under OS temporary directories. Browser uploads stream raw bytes to daemon-owned temporary storage without buffering/base64 in browser JavaScript; managed uploads survive send and expire by daemon retention or explicit removal before send. Local path references remain original files and are never deleted. OS cleanup can remove temporary chat history and managed uploads; persistent agent definitions and shared rooms remain daemon-owned durable data.

The operator explicitly permits filesystem access matching OMP's OS identity across the machine. `workspace:` is location metadata, not authorization. New privileged services accept authenticated operator authority; worker access is bound to authenticated peer identity and room membership. Remote full control is disabled unless explicitly configured. No browser shell-command endpoint. Git inspection uses fixed read-only argv and bounded output, never shell interpolation.

## Information architecture

- Slack-like global search/appearance toolbar and a 64px labeled icon rail beside a 260px sidebar with separate collapsible OMP chats, Channels, and Direct messages. Creation actions remain nearby; Cmd/Ctrl+K searches destinations and actions.
- Main conversation header: destination and effective working directory, model selector for independent chats, channel workspace editing, contextual agent actions. Conversation / Plans / Changes views preserve destination context.
- Transcript: left-aligned authored messages, small avatars, grouped consecutive messages, readable Markdown/code, reactions, thread actions available on hover and focus.
- Composer: full-width growing input, attachment tray, separate action row. Enter sends, Shift+Enter adds a line. Failed sends and uploads preserve draft. Device upload, local-path reference, drop, and paste remain visibly distinct.
- Agent Sheet: membership, stopped-agent DM waiting notice, explicit start/stop, steering, logs, accounts, and soul/definition editing. Bots are native durable agents with wake, autonomy, and schedule definition controls—not a parallel entity type.
- Create channel, create agent, create automated bot, and new OMP chat are real dialogs. Channel, peer, and independent-chat working directories use the daemon-backed `FilePicker`; explicit peer workspace overrides channel workspace. Existing IDs remain; browser tests open dialogs and sheets before using controls.
- Threads use a split only when enough transcript width remains; overlay on narrow viewports. Escape restores opener focus.
- Plans are daemon-persisted room artifacts editable by authorized participants. Native OMP chat plans use native todo state rather than an unrelated duplicate tracker.
- Changes show real Git status and diffs for the selected workspace. No fabricated progress, diffs, or charts.
- Existing PC attachments may be absolute local file-path references: only the path is sent and the original stays in place. Browser-selected, dropped, and pasted files instead use authenticated raw XHR uploads to daemon-owned temporary storage, with progress/cancel/error UI and no `arrayBuffer`, base64, or multipart conversion. Explicit removal of an unsent managed upload deletes only daemon-owned temporary bytes; successful send retains bytes until daemon retention cleanup.

## Visual system

Slack desktop is the reference, cross-checked against [sanidhyy/slack-clone](https://github.com/sanidhyy/slack-clone) and [TropicolX/slack-clone](https://github.com/TropicolX/slack-clone). The frame has depth rather than flat fills:

- **Workspace chrome.** A 64px icon rail with labels under each icon, a 44px toolbar with a centered translucent search field, and a 260px sidebar. Each surface is a gradient of its theme color (`.ws-rail-surface`, `.ws-toolbar-surface`, `.ws-sidebar-surface`) with a 1px translucent edge. Sidebar rows are 28px with 15px text; hover is a translucent wash, the active row is Slack blue, unread rows are bold with a badge, and direct messages show a square avatar with a presence dot for running, parked, or stopped.
- **Conversation.** A 49px channel header with a heavy title, the member stack inside the Agents button, and underline tabs with the working directory as a chip. Messages use 36px rounded-square avatars that default to a blobatar of the wire name, 15px body text, a hover wash, a floating action toolbar, reaction pills, a thread summary row, and centered date pills over a hairline.
- **Composer.** A bordered box with a Markdown formatting row, the text area, and an action row ending in a green send button.
- **Overlays.** Sheets and dialogs use 12px radii, a soft modal shadow, 22px heavy titles, bordered inputs with a blue focus ring, and green primary actions.

Themes are curated, not generated. `web/src/lib/themes.ts` defines six sidebar themes after Slack's own (Aubergine, the default, plus Ochin, Hoth, Monument, Work Hard, and Nocturne). A theme sets only the `--ws-*` chrome variables; content surfaces come from one light and one dark token set in `web/src/index.css`, so every theme keeps their contrast guarantees: each text token clears 7:1 on every surface it is painted on, which the browser suite checks. Theme and light/dark/system mode are browser-local and applied before React renders; a stored id from the retired 59-palette catalog falls back to Aubergine and keeps its mode.

System sans and monospace with no webfont, 15px body, 13px secondary text, 8px radii (6px on inputs), visible focus rings, 44px touch targets on coarse pointers, and reduced motion. No fake Slack actions: every rail icon, header control, and composer button does something real. No runtime theme downloads.

## States and verification

Designed loading skeletons, empty conversation actions, reconnect/offline and load-failure states, inline parser/upload errors, stopped-DM waiting notices, remote-control denial, and destructive confirmation naming the affected subtree. Keyboard plus 320px and 390px layouts must work.

Storybook renders real components with populated room/chat transcripts, explicit workspaces, agent/bot creation, composer attachment states, threads, plans, and changes, without a daemon. Visual acceptance uses desktop and 320/390px browser journeys, overflow checks, and keyboard operation across creation, destination switching, uploads, local references, workspace editing, stopped DMs, and remote denial.

Build remains exactly index.html, app.js, style.css in src/console; literal asset paths and dark HTML preserved. Verify console and daemon suites, native session lifecycle, model selection, attachments, plans, Git inspection, remote denial, and real browser journeys. No npm publication. Update guide and changelog, remove HANDOFF-WEBUI.md only when finished, commit and push.
