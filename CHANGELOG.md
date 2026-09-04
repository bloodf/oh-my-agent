# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

From 1.0 onward this project follows semver: major versions carry breaking changes, minor versions add features, and patch versions add fixes. Roll back a bad release with `npm deprecate` and a forward patch release; never unpublish. For each release, bump `package.json` and `omp.version`, move entries from Unreleased into a dated version, and tag that release commit.

## [Unreleased]

### Added

- TUI auto-starts the detached daemon on session start from the plugin tree, so `omp install` then `omp` is enough. PATH and `omp-agent daemon` stay optional for the CLI.
- `/cli <verb>` and `/console` run the same CLI dispatcher inside the TUI, so shell PATH is not required to print status or the browser console URL.
- Console storybook at `bun run storybook`: pages, components, and states painted with production `style.css`, no daemon required.

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
