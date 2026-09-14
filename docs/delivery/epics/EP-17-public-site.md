# EP-17 — Public homepage and console demo

**Status:** Done

*Derived from the tasks below.*

## Outcome

Anyone can see what oh-my-agent is and click through the real console with believable data without installing anything: a single-page animated homepage and a mocked demo, both on Vercel.

## Why this is its own epic

A README cannot show a running daemon, a room with agents talking, or the agent sheet. The console is the product's most legible surface and it was invisible to anyone who had not installed the plugin.

## In scope

- The tasks in this epic.

## Not in scope

- Changing the daemon, the console, or the npm package.
- A hosted daemon: the demo is browser-local by design.
- Analytics, accounts, or any server-side state on the site.

## Acceptance

- [x] The homepage renders its WebGL scenes lazily, degrades under reduced motion, and has no horizontal overflow at 400px.
- [x] Every console view, sheet, tab, and dialog is reachable in the demo and every mutation persists across a reload.
- [x] The demo opens without a login and still exercises the console's operator-token path.
- [x] A smoke script calls every mocked route and reports zero throws.

## Decisions

- [ADR-017](../adr/ADR-017-public-site.md) — A public homepage and a mocked console demo, hosted outside the daemon

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1701](../tasks/T-1701-public-site.md) | Public homepage and mocked console demo on Vercel | Done |
