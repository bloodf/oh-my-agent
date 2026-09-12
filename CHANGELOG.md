# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

From 1.0 onward this project follows semver: major versions carry breaking changes, minor versions add features, and patch versions add fixes. Roll back a bad release with `npm deprecate` and a forward patch release; never unpublish. For each release, bump `package.json` and `omp.version`, move entries from Unreleased into a dated version, and tag that release commit.

## [Unreleased]

### Added

- The console loads in a fraction of the size: mermaid and its diagram packs are lazily imported, content-hashed chunks fetched only when a diagram is on screen, served `immutable` and gzipped. `app.js` drops from about six megabytes to under one. In remote mode the shell carries a reusable chunk pass bound to the chunk path prefix.

- Lavish Editor is part of the crew's toolkit. A `lavish` skill ships with the package and every default peer and preset declares it: an agent writes an HTML artifact, opens it with `npx -y lavish-axi`, and polls for feedback. Workers run Lavish headless against your own `~/.lavish-axi`, and the console's new Artifacts view lists every session with **Open review**, backed by `GET`/`POST /api/artifacts`.
- Definitions that select `skills:` now start. The daemon never handed the materializer the package's skill roots, so any `skills:` entry failed with "Unknown skill" outside the test suite.
- The console's agent sheet has a Schedules tab: every cron schedule, heartbeat, and automation with its next fire, a pause/resume switch, and a form that adds a cron schedule to an agent. `/api/schedules` and `PATCH /api/schedules/:id` back it.
- Profile and avatars in the console: your display name and avatar, and a display name and avatar per agent, saved daemon-side (`/api/profile`) so every console shows them. Names on the wire do not change.
- The console renders message and plan bodies as GitHub-flavored Markdown — headings, lists and task lists, tables, links, inline and fenced code with `diff` tinting — and draws ` ```mermaid ` fences as diagrams in the console's palette. A diagram that does not parse shows its source and the error.
- A `heartbeat: { every, prompt? }` definition key. A running peer gets a standing turn every interval — read your rooms and plans, continue unfinished work, post progress, answer `idle` if nothing is pending — queued behind any turn in flight, so a crew keeps working without an orchestrator waking it. Listed and armed as `<name>:heartbeat` beside the schedules; `schedule <id> off` pauses it across restarts. The default crew and every preset declare `every: "30m"`.

## [1.4.0] - 2026-09-11

### Added

- `mate`, the first mate, joins the default crew: the one peer you talk to. Post in `#bridge`; it picks the task shape (ship or scout), briefs the staff, supervises through the rooms, escalates only real decisions, and reports outcomes there.
- A preset library ships with the package and is never seeded: `researcher`, `reviewer`, `security-reviewer`, `tech-writer`, `sre`, `debugger`, `test-engineer`, `designer`, `release-manager`, `data-analyst`. `/preset` in the TUI, `omp-agent presets` and `agent create <name> --preset <preset>` in the shell, a **Start from a preset** picker in the console's create dialog, and `presets_list` on the control socket (worker-callable, so `mate` hires from it).

- Channels from every surface: `/rooms create`, `/rooms join`, and `/rooms leave` in the TUI; `omp-agent rooms create|join|leave` in the shell; `room_create`, `room_join`, and `room_leave` on the control socket, the first two worker-callable so a peer can open a channel and assign teammates to it. A join is written to the peer's definition; a running peer is subscribed at once and reads the room's whole history as its next turn.
- Status reactions from the daemon, the way teammates react in Slack: every message delivered to a peer gets its 👀, a message addressed to it (mention or DM) carries ⏳ while the peer's turn runs and then ✅ or ❌ when it ends. A peer's own `chat_react` calls layer on top.
- Invite by mention: `@name` in a room the peer is not in adds the room to its definition, subscribes it live, and delivers the room's backlog to it. It used to receive the one message and nothing else.

- `/setup` in the TUI and `omp-agent setup` in the shell: a checklist of what a working install needs (daemon, routable models, the default model, the crew, the rooms), one ✓ or ✗ line each with the fix on every ✗. The TUI offers the two fixes it can apply: put the crew on a model the daemon can route to, and start stopped crew peers. An `oh-my-agent-setup` skill ships with the plugin so the OMP assistant can walk an operator through the same lines.

### Changed

- The plugin binds no keys. `Alt+G` is gone; `/manage` opens the manager, and every surface is a slash command, so nothing collides with a binding you or another extension own.
- The status widget and the manager overlay render through your OMP theme: its colors, its symbol preset (unicode, nerd, or ascii) for the cursor, status marks, separators, and arrow hints. The widget reads `oh-my-agent · N running · N parked · N unread · /manage`.

## [1.3.0] - 2026-09-11

### Added

- A default team ships with the package: `staff-pm`, `staff-backend`, `staff-frontend`, and `staff-qa`, seeded into the user store once on the daemon's first boot, each with its own room and a shared `#team`. Edits and deletions are kept on later boots.
- A peer with no `model` runs on OMP's default model role, so the default team starts without any configuration. `status` and `agents` name the model a peer actually runs on.
- `models_list` on the control socket, `omp-agent models`, `/edit <name>` → Model, and the console's agent form all offer every model the daemon's credentials can reach, with the default marked.

### Fixed

- The TUI no longer reports a running daemon as absent. A missing or refused operator token used to read as "not running", so every session start spawned a second daemon that died on the pidfile and logged an uncaught exception. Token faults are now reported as such and never trigger a spawn; a second launch against a live daemon points at it and exits cleanly; and the daemon rewrites `console-token` and `console-url` if they go missing under it.
- Shutdown runs every teardown step even when one fails, so a SQLite error no longer leaves the pidfile and socket behind.
- `status` reports the daemon's version and why a peer failed to start, and the TUI warns when the running daemon is older than the plugin. `agents` prints the start failure.
- The status widget counts messages the operator has not seen, instead of re-reading every message in every room after each turn.
- A killed peer is no longer brought back to life by a definition change, and no longer counts against its account's quota. Accounts that park or resume with no runs no longer get stuck.
- Yearly and other long-interval schedules no longer fire in a loop; delays beyond 24.8 days are chained. Dates that can never occur are refused at arm time.
- `logs_tail` returns worker output; it returned an empty string for every worker. Workers may call `agent_create`, which the toolbelt already instructed them to do.
- Room databases created before threading are migrated instead of failing every room operation.
- Sandboxed peers can start on Linux via `sandbox.allowUnenforcedNetwork`, and macOS sandbox profiles can read the OMP CLI and `bun` they run. Worker pids are reported on installs without this repository's OMP patch.
- The console no longer reads whole room histories on each post, reaction, and connect; its loopback page is no longer cached or leaked by Referer; the address bar drops the token after reading it; and loopback WebSocket upgrades from foreign origins are refused. Pasted chat images reach the model.
- Web chats work on installs without this repository's OMP patch. They judged liveness from `RpcClient.pid`, which only the patch provides, so on a consumer install every chat was treated as dead: dropped a second after starting and refused every operation as closed.
- The `RpcClient.pid` patch is removed. Pids come from the launch shim's record, so a checkout and an npm install report them the same way. The OMP peer floor is now 18.1.0, and development runs on 18.1.17.
- A bare `omp-agent` prints usage instead of starting a daemon. Broker probes and the launcher's readiness wait are bounded, and `daemon restart` no longer deadlocks on a full pipe.

## [1.2.1] - 2026-09-08

### Fixed

- Launch daemon TypeScript with Bun when OMP is installed as a compiled binary, including TUI autostart and restart.
- Validate CLI startup arguments before loading worker/model SDKs, and complete the detached readiness handshake even with the web console disabled.
- Give supervised RPC workers a real, model-scoped inference gateway and native model discovery. Keep provider credentials in the daemon and load only the worker collaboration toolbelt, not the operator extension.
- Authenticate in-process collaboration tools with session-local credentials, and preserve worker gateway ownership during concurrent starts and cleanup.
- Open the web console from an explicit OMP menu with Open, Copy, and Show URL actions. Use Alt+G for the peer manager without colliding with OMP's external editor; use `/cli agents` without shadowing native `/agents`.
- Close the fullscreen manager before opening definition/model editors, and refresh the status widget after manager actions.
- Correct first-run scout prerequisites, shell room quoting, frontend dependency installation, and generated-console documentation.

## [1.2.0] - 2026-09-06

### Changed

- A single manual release dispatch now publishes the verified tarball to npm automatically after all gates pass, retaining the npm-publish environment approval and provenance. Removed the separate publish checkbox and second dispatch.
- Web messaging gains persistent thread links, distinct agent/bot creation, canonical channel and agent workspaces, explicit native Start, and scheduled-bot activation without daemon restart.
- Browser-selected, dropped, and pasted files now stream into private temporary storage with progress, cancellation, owned-only deletion, and 24-hour retention. Local original files remain no-copy path references.
- Repository branding, product screenshots, and architecture illustrations now reflect the conversation workspace rather than the retired console imagery.
- Web workspace now uses a Slack-inspired global search bar, compact app navigation, separate collapsible chats/channels/DMs, and chronological message dividers. Appearance offers 59 shadcn.io-derived color palettes with persistent light, dark, and system modes.

### Fixed

- Require remote full-control opt-in for explicit agent Start, preserve child parentage when restarting, and keep migrated temporary attachments readable across repeated accesses.

## [1.1.0] - 2026-09-05

### Added

- TUI auto-starts the detached daemon on session start from the plugin tree, so `omp install` then `omp` is enough. PATH and `omp-agent daemon` stay optional for the CLI.
- `/cli <verb>` and `/console` run the same CLI dispatcher inside the TUI, so shell PATH is not required to print status or the browser console URL.
- Conversation-first OMP web workspace with independent native chats alongside durable rooms and DMs. Each chat runs in its selected folder with normal OMP discovery, its own live model catalog and selection, and destination-preserving Conversation, Plans, and Changes views.
- Independent chat metadata, native sessions, and pasted clipboard images stay in OS temporary storage. Existing machine files remain in place and attach by absolute path through the daemon-backed picker; workspaces are not copied or browser-uploaded.
- Local operator access follows the daemon's full OS filesystem authority; privileged HTTP and WebSocket workspace operations remain disabled for remote clients unless `OMA_REMOTE_FULL_CONTROL=1` explicitly opts in. Git status and diffs use bounded, read-only commands rather than a shell endpoint.
- Rooms gain durable, revision-checked plans, while workspace Changes displays real Git status and file diffs instead of fabricated progress.
- Agent controls now cover creation, membership, steering, logs, stop, account ceilings, and soul/definition editing through the real daemon APIs.
- Console storybook at `bun run storybook` catalogs the production pages, components, dialogs, and operational states with isolated demo data and production `style.css`, no daemon required.
- Operator console rebuilt with latest shadcn/ui (Radix, Tailwind v4) as the compact conversation workspace, including rooms-first navigation, keyboard search, responsive threads, attachments, and designed offline/error states.

## [1.0.4] - 2026-09-04

### Fixed

- Register changelog helpers and release workflows in the delivery tree so the docs gate owns them.

## [1.0.3] - 2026-09-04

### Fixed

- Exclude Archify diagram JSON/SVG and brand rasters from Biome so the release lint gate can pass.

## [1.0.2] - 2026-09-04

### Changed

- Documentation overhaul: newcomer guide, contributor map, brand assets, and Archify diagrams (JSON + SVG, no HTML).
- Manual release workflows: changelog draft, prepare-release PR, GitHub Release, opt-in npm publish.

## [1.0.1] - 2026-09-04

Fixes found by driving the daemon end to end as a new user would, rather than through the suite. Every defect below was reproduced live before the fix and re-verified after, through the CLI and a real browser.

### Fixed

- **The shipped example agents could not be created or spawned.** Both `agents/example-*.md` declared `tools:`, which `agent create` refuses because it accepts only the definition subset. Both also used a `model: "@role"` selector that no code resolves — `resolveWorkerModel` requires a literal `provider/id`, so every example we shipped was unspawnable and `ARCHITECTURE.md` documented the broken form as working. The examples and the peer-definition docs now use a fully qualified model.
- **A post to a room whose member agent is stopped returned 500 after storing the message.** The exception from prompting a stopped worker reached the console's catch-all, so the operator was told the post failed for work the room had already accepted, and a retrying browser duplicated it. Delivery now holds the backlog for a stopped worker, exactly as it already did for a stale definition. A parked member is unaffected.
- **A budget bump accepted zero and negative ceilings.** The usage poller tracks spend as `burned / ceiling`: zero divides to `Infinity` and parks an account that has spent nothing, and a negative clamps the ratio to zero so the account never warns and never parks — a spend cap that looks configured while protecting nothing. Bumps are now validated as strictly positive at the protocol boundary and again in the supervisor, before any mutation.
- **`.omp/` is ignored.** The daemon writes project-scoped peer definitions under `<project>/.omp/oh-my-agent/agents/`, so running it inside a repository left untracked state in the tree.
- **The consumer-install smoke no longer fails as a timeout.** `npm pack` runs the typecheck and the whole fast suite in `prepack`, which needs minutes; it now has its own budget instead of sharing the 120-second default.

## [1.0.0] - 2026-09-04

First stable release. The `omp-agent` daemon runs autonomous, long-lived agents that keep working after the terminal closes, talk to each other in persistent chat rooms, and stay observable and steerable from the OMP TUI, a browser console, or a shell.

### Added

- **Autonomy.** `omp-agent daemon` runs detached from any TTY; closing the terminal does not stop active agents. The supervisor owns worker lifecycle, restart backoff, and per-user-profile socket + pidfile placement.
- **Multi-agent collaboration.** Persistent channels and DMs backed by SQLite, with threads, reactions, durable mentions, subscriptions, and per-agent read cursors. Mention and room-wake filters resume parked peers by batching pending messages into one turn; humans are first-class participants via the TUI extension.
- **Hierarchy with parentage enforcement.** Agents can author and deploy child agents. The `spawns:` frontmatter list is the spawn policy at dispatch time; the materializer snapshots `discoverAgents(workerCwd)` at spawn as defense-in-depth and writes non-allowlisted names into the worker's `task.disabledAgents`. Native OMP `task` handles in-run subagent delegation; the toolbelt's `agent_spawn` is reserved for standing up durable teammates and is rejected for coding subtasks.
- **Scheduling.** Cron expressions and one-shot timers persisted in SQLite; cron fires post their configured prompt into a room, which may wake subscribers. Definitions carry `schedules:` (timer-armed) and `automations:` (event-driven) blocks.
- **Quota handling.** Billing is a property of the account, not the agent. Metered (API-key) accounts warn in the room at 80% of `budgetUsd` and park at 100%; a human resumes with a bump or kills. Subscription accounts park on quota-exhaustion and arm an unattended auto-resume at quota reset via a one-shot timer, so work continues with no human in the loop.
- **Isolation.** Each worker gets a private root containing only the definitions it is allowed to see. An opt-in OS sandbox (macOS Seatbelt, Linux `bwrap`) wraps the RPC subprocess, with per-worker scoped credentials routed through a daemon-side credential gateway.
- **Three drive surfaces.** The OMP TUI extension (slash commands `/agents`, `/rooms`, `/schedule`, status widget, chat renderer); the `omp-agent` CLI (`daemon`, `status`, `console`, `audit`); and a browser console backed by token-protected loopback HTTP plus a WebSocket event feed.
- **Scoped broker hosting.** At boot the daemon runs the OMP client discovery chain, then fronts every worker with a per-worker gateway bearer that filters `GET /v1/snapshot`, refresh, block, and usage data, and rewrites generations to a monotonically increasing worker-view generation. Foreign-id access, credential updates, and shared disables return 403; dedicated disables proxy upstream; the worker holds no upstream broker token.

### Known limitations

- **npm consumers receive an unpatched `@oh-my-pi/pi-coding-agent` peer (ADR-013).** `RpcClient.pid` is therefore absent, and worker supervision cannot rely on the OMP patch; the consumer-install smoke asserts this degraded state on purpose (`EXPECTED_RPC_CLIENT_PID = "absent"`). Under npm 12 the patch is additionally stripped from the published tarball outright, so the patch riding along in the repo is real and applied by `bun install` for developers but inert for npm consumers.
- **Two of the three documented proxy recipes in `docs/remote-exposure.md` are verified; one is not.** The `Caddy with public TLS` and `SSH tunnel with loopback Caddy` recipes were verified end to end on 2026-09-03 against real Caddy-terminated TLS, but both terminated on an internal CA rather than public ACME, so public ACME issuance and renewal remain UNVERIFIED. The `tailscale serve` recipe is UNVERIFIED: it needs two tailnet devices, and no second device on this tailnet accepted a shell, nor was an auth key available to enlist one.

## [0.1.0] - 2026-09-02

### Added

- Initial pre-release baseline.
