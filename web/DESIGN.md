# OMP conversation workspace

## Product and decisions

A local-first web interface to OMP: independent chats launched in a selected workspace, persistent agent DMs, and shared rooms. The conversation is the primary surface, not a dashboard widget. Operator approved real creation dialogs, rooms-first navigation, live repository changes, durable plans, and explicit remote full-control opt-in.

Independent chats run native OMP RPC subprocesses with cwd set to the selected folder and normal operator configuration discovery. They are not registered persistent agents. Model catalogs come from that session; model choice is per chat. Existing peer isolation remains unchanged.

The operator explicitly permits filesystem access matching OMP's OS identity across the machine. `workspace:` is location metadata, not authorization. New privileged services accept authenticated operator authority; worker access is bound to authenticated peer identity and room membership. Remote full control is disabled unless explicitly configured. No browser shell-command endpoint. Git inspection uses fixed read-only argv and bounded output, never shell interpolation.

## Information architecture

- Compact 232px rail: New chat, Chats, Rooms, Direct messages. Room unread state remains visible; Cmd/Ctrl+K searches destinations and actions.
- Main conversation header: destination, workspace where applicable, model selector for independent chats, contextual agent actions. Conversation / Plans / Changes views preserve destination context.
- Transcript: left-aligned authored messages, small avatars, grouped consecutive messages, readable Markdown/code, reactions, thread actions available on hover and focus.
- Composer: full-width growing input, attachment tray, separate action row. Enter sends, Shift+Enter adds a line. Failed sends preserve draft and attachments.
- Agent Sheet: membership, steering, logs, stop, accounts, and soul/definition editing. No permanent operations column.
- Create room, create agent, and new chat are real dialogs. Existing IDs remain; browser tests open the dialogs and sheets before using controls.
- Threads use a split only when enough transcript width remains; overlay on narrow viewports. Escape restores opener focus.
- Plans are daemon-persisted room artifacts editable by authorized participants. Native OMP chat plans use native todo state rather than an unrelated duplicate tracker.
- Changes show real Git status and diffs for the selected workspace. No fabricated progress, diffs, or charts.
- Paste/drop/file selection uploads attachments. Images use native multimodal input when supported; files and videos remain accessible to OMP read tools through actual stored paths. Unsupported decoding is surfaced honestly.

## Visual system

Neutral OKLCH near-black canvas, subtly lighter rail and overlays. One sky accent; amber reserved for @you. System sans and system monospace; no font assets. Body 14px, metadata 12px, spacing based on 4/8px, compact controls with accessible targets, modest radii. High-contrast text, visible focus rings, reduced-motion support. No glass, gradient mesh, uppercase eyebrows, decorative gauges, or fake chrome.

## States and verification

Designed loading skeletons, empty conversation actions, reconnect/offline and load-failure states, inline parser errors and destructive confirmation naming the affected subtree. Keyboard and 390px layouts must work. Storybook renders the real new components with isolated demo data, without a daemon.

Build remains exactly index.html, app.js, style.css in src/console; literal asset paths and dark HTML preserved. Verify console and daemon suites, native session lifecycle, model selection, attachments, plans, Git inspection, remote denial, and real browser journeys. No npm publication. Update guide and changelog, remove HANDOFF-WEBUI.md only when finished, commit and push.
