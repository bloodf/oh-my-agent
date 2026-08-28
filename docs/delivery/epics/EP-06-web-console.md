# EP-06 — Web console: manage agents and channels from a browser

**Status:** Done

*Derived from the tasks below.*

## Outcome

A browser UI where a human creates agents and channels, puts agents in channels, and holds a Slack-like conversation with them: replies, threads, and emoji reactions.

## Why this is its own epic

The TUI (EP-05) reaches whoever is at the terminal that launched the daemon. Long-lived agents outlive that terminal by design, so the natural way to check on them is a URL. This epic is also where the message model stops being a flat log: threads keep several agents talking at once from becoming unreadable, and reactions double as machine-readable status an agent can set on a message without adding noise to the channel.

## In scope

- Message model: parent/child replies, thread roots, and reactions.
- HTTP and WebSocket API over the daemon's existing state.
- Browser client: channel list, transcript, thread pane, composer.
- Create and configure agents and channels from the UI.
- Membership: add and remove agents from channels, applied to live workers.
- Reactions as agent status, settable through the toolbelt.

## Not in scope

- Multi-user accounts or auth beyond the daemon's single-operator model.
- Replacing the TUI; both talk to the same daemon.
- Editing or deleting another participant's messages.

## Acceptance

- [x] A channel created in the UI is immediately visible to a worker. Worker-side channel creation is deliberately not in this epic: no task builds such a tool, and an acceptance item nothing implements is a promise that quietly fails.
- [x] An agent added to a channel receives its next message.
- [x] A reply appears in a thread without cluttering the channel root.
- [x] An agent can set a reaction, and it appears in an open browser without a refresh.
- [x] A membership change reaches a running agent on the next post, with no restart.
- [x] Closing the browser does not stop or park any agent.

## Decisions

- [ADR-009](../adr/ADR-009-threads-and-reactions.md) — Conversation gains threads and reactions; reactions carry agent status

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-601](../tasks/T-601-conversation-model.md) | Threads, replies, and reactions in the store | Done |
| [T-602](../tasks/T-602-console-api.md) | Daemon HTTP and WebSocket API | Done |
| [T-603](../tasks/T-603-console-client.md) | Browser client | Done |
| [T-604](../tasks/T-604-reaction-toolbelt.md) | Agents set reactions as status | Done |
| [T-605](../tasks/T-605-console-management.md) | Create agents and channels from the UI | Done |
