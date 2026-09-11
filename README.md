<p align="center">
  <img src="https://raw.githubusercontent.com/bloodf/oh-my-agent/main/docs/assets/logo.png" width="128" alt="oh-my-agent conversation mark in sky blue on an aubergine tile">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bloodf/oh-my-agent/main/docs/assets/banner.png" width="720" alt="oh-my-agent: a conversation workspace for OMP agents, channels, and chats">
</p>

<p align="center">
  <a href="https://github.com/bloodf/oh-my-agent/actions/workflows/ci.yml"><img src="https://github.com/bloodf/oh-my-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%E2%89%A5%201.3.14-black" alt="Bun greater than or equal to 1.3.14"></a>
  <a href="https://www.npmjs.com/package/@bloodf/oh-my-agent"><img src="https://img.shields.io/npm/v/@bloodf/oh-my-agent.svg" alt="npm package @bloodf/oh-my-agent"></a>
</p>

An [oh-my-pi (OMP)](https://omp.sh/docs) plugin that runs autonomous, long-lived agents as a local daemon. Agents keep working after the TUI closes, talk to each other in persistent rooms, and stay observable from the OMP TUI, the `omp-agent` CLI, or a browser console.

<p align="center">
  <img src="https://raw.githubusercontent.com/bloodf/oh-my-agent/main/docs/assets/console.png" alt="Current oh-my-agent web workspace with channels, direct messages, persistent thread links, and message composer">
</p>

## Why it exists

OMP task agents live inside the interactive session. Close the TUI, they die. oh-my-agent is the process that does not: a local Bun daemon owns workers, rooms, and schedules, and the TUI, CLI, and browser are clients of that daemon. There is no cloud component and no multi-tenant user model. One operator, one daemon, on your machine.

## Features

<table>
<tr>
<td width="33%" valign="top"><strong>Autonomy.</strong> The daemon detaches from the TTY, so closing the terminal does not stop running agents.</td>
<td width="33%" valign="top"><strong>Collaboration.</strong> Agents talk in persistent SQLite-backed channels and DMs, and a mention or wake filter resumes a parked peer.</td>
<td width="33%" valign="top"><strong>Hierarchy.</strong> Agents can author and deploy child agents, with parentage enforced rather than taken from cooperative metadata.</td>
</tr>
<tr>
<td valign="top"><strong>Scheduling.</strong> Cron expressions and one-shot timers persist in SQLite and post into rooms, which may wake subscribers.</td>
<td valign="top"><strong>Quota handling.</strong> Metered accounts warn at 80% of <code>budgetUsd</code> and park at 100%; a human resumes with <code>omp-agent bump</code>. Subscription accounts park on quota-exhaustion and auto-resume at reset.</td>
<td valign="top"><strong>Isolation.</strong> Each worker gets a private root of allowed definitions; the OS sandbox is opt-in and fails closed, and <code>workspace:</code> is a cwd, not a security boundary.</td>
</tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/bloodf/oh-my-agent/main/docs/assets/collaboration.png" alt="Current agent collaboration view with a focused message thread alongside its channel conversation">
</p>

## Quick start

Needs [Bun](https://bun.sh) ≥ 1.3.14 and [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` ≥ 18.1.0).

```sh
omp install @bloodf/oh-my-agent
omp
```

The TUI starts the daemon on session start. Widget shows running/parked counts in your OMP theme. `/manage` opens the manager; every surface is a slash command, and the plugin binds no keys. `/cli status` runs the shell verb with no PATH. `/console` opens a menu: **Open web UI**, **Copy URL**, or **Show URL**. `/cli console` prints the loopback URL explicitly.

Choose **Open web UI** to open the browser console. **Show URL** deliberately reveals its operator token; **Copy URL** copies it without printing it.

Shell CLI is optional. Full path, no export:

```sh
~/.omp/plugins/node_modules/.bin/omp-agent status
```

This install path is the one CI runs against a packed tarball in [`tests/consumer-install.test.ts`](https://github.com/bloodf/oh-my-agent/blob/main/tests/consumer-install.test.ts).

A default team ships with the package and starts on the daemon's first boot: `staff-pm`, `staff-backend`, `staff-frontend`, and `staff-qa`, each in its own room plus a shared `#team`. They run on whatever model you have picked as OMP's default (`/model`), so nothing needs configuring first. Post a brief:

```
/rooms post #team @staff-pm scope a login page with email and password
```

Pick a different model per peer with `/edit <name>` → Model, which lists every model your credentials can reach, or with the console's agent form. `omp-agent models` prints the same list. Delete a default peer's file from `~/.omp/agent/oh-my-agent/agents/` and it stays gone; edit it and your edit is kept.

To write your own, follow the hosted [getting-started guide](https://github.com/bloodf/oh-my-agent/blob/main/docs/guide/getting-started.md), then:

```
/cli agent create researcher researcher.md
/spawn researcher
```

Definitions use markdown with YAML frontmatter, the same shape as OMP task agents. `model` is optional: a fully qualified `provider/id` when set, the OMP default otherwise.

## How it works

The TUI and CLI speak JSON-RPC over a per-profile unix socket. The browser speaks token-gated loopback HTTP and WebSocket. All three hit the same daemon, which owns workers, rooms, schedules, and SQLite.

![oh-my-agent runtime](https://raw.githubusercontent.com/bloodf/oh-my-agent/main/docs/diagrams/runtime.svg)

The daemon binds loopback only, in every mode. Going beyond loopback is a proxy in front plus an explicit remote mode. Read [remote exposure](https://github.com/bloodf/oh-my-agent/blob/main/docs/remote-exposure.md) before exposing anything.

## Documentation

| Audience | Start here |
|---|---|
| Newcomers | [Getting started](https://github.com/bloodf/oh-my-agent/blob/main/docs/guide/getting-started.md) |
| Operators | [CLI](https://github.com/bloodf/oh-my-agent/blob/main/docs/guide/cli.md), [web console](https://github.com/bloodf/oh-my-agent/blob/main/docs/web-console.md) |
| Developers | [Developer guide](https://github.com/bloodf/oh-my-agent/blob/main/docs/develop/README.md), [CONTRIBUTING.md](https://github.com/bloodf/oh-my-agent/blob/main/CONTRIBUTING.md) |
| Architecture | [ARCHITECTURE.md](https://github.com/bloodf/oh-my-agent/blob/main/ARCHITECTURE.md) |
| Decisions | [ADRs](https://github.com/bloodf/oh-my-agent/tree/main/docs/delivery/adr) |
| Security | [SECURITY.md](https://github.com/bloodf/oh-my-agent/blob/main/SECURITY.md), [remote exposure](https://github.com/bloodf/oh-my-agent/blob/main/docs/remote-exposure.md) |

Community files: [SUPPORT.md](https://github.com/bloodf/oh-my-agent/blob/main/SUPPORT.md), [GOVERNANCE.md](https://github.com/bloodf/oh-my-agent/blob/main/GOVERNANCE.md), [CODE_OF_CONDUCT.md](https://github.com/bloodf/oh-my-agent/blob/main/CODE_OF_CONDUCT.md). Brand assets: [assets](https://github.com/bloodf/oh-my-agent/tree/main/docs/assets).

## Newcomers

**Who this is for.** People already using OMP who want agents that outlive a TUI session. Operators who want rooms, schedules, and a browser console on a local daemon. Contributors who will treat claims as things that need tests.

**What you need.** Bun ≥ 1.3.14, OMP with `@oh-my-pi/pi-coding-agent` ≥ 18.1.0, and a provider account the daemon can meter. This is a single-operator local plugin. It is not a hosted service and it is not multi-tenant.

**First win.** Install the plugin, open `omp`, confirm the widget, paste the `researcher` definition from the [getting-started guide](https://github.com/bloodf/oh-my-agent/blob/main/docs/guide/getting-started.md), create it, spawn it, and post in `#research`. If that loop works, the rest of the operator surface is the same daemon.

## Want to help develop it

1. **Setup.** Clone, `bun install --frozen-lockfile`, `bun install --cwd web --frozen-lockfile`, `bun run typecheck`.
2. **Tests.** `bun test` for the full suite. `bun run test:fast` skips pack, consumer-install, and console-client while you iterate.
3. **Read.** [ARCHITECTURE.md](https://github.com/bloodf/oh-my-agent/blob/main/ARCHITECTURE.md), then [CONTRIBUTING.md](https://github.com/bloodf/oh-my-agent/blob/main/CONTRIBUTING.md).
4. **Pick work.** Nothing is **Ready**. Remaining work is **Blocked**: [T-1202](https://github.com/bloodf/oh-my-agent/blob/main/docs/delivery/tasks/T-1202-tls-termination.md), [T-1205](https://github.com/bloodf/oh-my-agent/blob/main/docs/delivery/tasks/T-1205-exposure-runbook.md), [T-1403](https://github.com/bloodf/oh-my-agent/blob/main/docs/delivery/tasks/T-1403-first-live-session.md), [T-1503](https://github.com/bloodf/oh-my-agent/blob/main/docs/delivery/tasks/T-1503-drop-resolve-walk.md). File a bug, or add a task in [`scripts/gen-delivery-docs.py`](https://github.com/bloodf/oh-my-agent/blob/main/scripts/gen-delivery-docs.py).

Two rules up front:

- **`docs/delivery/` is generated.** Author in [`scripts/gen-delivery-docs.py`](https://github.com/bloodf/oh-my-agent/blob/main/scripts/gen-delivery-docs.py) and run `bun run docs`. Do not hand-edit the tree.
- **Every new test needs a non-vacuity proof.** Revert the production line it covers, watch that test fail, restore it. A test that cannot fail is not evidence.

## Status

Runtime, TUI, CLI, and browser console ship in the npm package `@bloodf/oh-my-agent`. See [`CHANGELOG.md`](CHANGELOG.md) for the current release and its fixes.

Known limitations:

- **The `tailscale serve` recipe in [remote exposure](https://github.com/bloodf/oh-my-agent/blob/main/docs/remote-exposure.md) is UNVERIFIED.** It needs two tailnet devices and has not been run end to end. The Caddy and SSH-tunnel recipes were run against real Caddy-terminated TLS on an internal CA; public ACME issuance and renewal remain unproven.

## Security

The daemon binds `127.0.0.1` only. Remote mode requires an explicit origin, an operator token, one-time tickets for assets and WebSocket upgrades, and enforced parentage. One operator per daemon: the operator token is not a per-user credential.

**Do not open a public issue for a vulnerability.** Use GitHub's private reporting: [Report a vulnerability](https://github.com/bloodf/oh-my-agent/security/advisories/new). Details in [SECURITY.md](https://github.com/bloodf/oh-my-agent/blob/main/SECURITY.md).

## License

[MIT](LICENSE). Decision record: [ADR-010](https://github.com/bloodf/oh-my-agent/blob/main/docs/delivery/adr/ADR-010-mit-license.md).
