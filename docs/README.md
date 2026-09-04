# oh-my-agent documentation

![oh-my-agent mark](assets/mark.png)

![oh-my-agent](assets/banner.png)

`@bloodf/oh-my-agent` is an MIT-licensed [OMP](https://omp.sh/docs) plugin. It runs autonomous, long-lived agents as supervised workers. They keep working after the terminal closes, talk in persistent rooms, and stay steerable from the OMP TUI, the `omp-agent` CLI, or a browser console.

This hub is the map. Start with the newcomer guide unless you already run the daemon.

## Choose a path

| You are | Start here |
|---|---|
| New to the plugin, have Bun and OMP already | [Getting started](guide/getting-started.md) |
| Operating a running daemon | [CLI](guide/cli.md), [Console](guide/console.md), [Security](guide/security.md) |
| Exposing the console beyond this machine | [Remote exposure](remote-exposure.md) |
| Changing the code | [Developing](develop/README.md), [Contributing](../CONTRIBUTING.md), [Architecture](../ARCHITECTURE.md) |

## Newcomer guide

Read these in order the first time.

| Document | What it covers |
|---|---|
| [Getting started](guide/getting-started.md) | Install, open `omp` (daemon auto-starts), create and spawn the example researcher, post to a room |
| [Concepts](guide/concepts.md) | Daemon, workers, rooms, TUI, console, and how they connect |
| [Agents](guide/agents.md) | Peer definition format, frontmatter reference, create vs edit, first-timer errors |
| [CLI](guide/cli.md) | Every `omp-agent` verb, flags, exit codes, `--json` |
| [Console](guide/console.md) | Browser console, operator token, environment variables |
| [Rooms](guide/rooms.md) | Channels, DMs, wake filters, posting as `@you` |
| [Security](guide/security.md) | Loopback default, token, sandbox honesty, how to report a vulnerability |
| [FAQ](guide/faq.md) | Real gotchas: create subset, model ids, workspace vs sandbox, npm peer patch, daemon-down sentence |

## Operator docs

These stay the source of truth for running and exposing a live daemon. The guide pages summarize and point here.

| Document | What it covers |
|---|---|
| [Web console](web-console.md) | Token lifecycle, HTTP and WebSocket API, client panes, auth rules |
| [Remote exposure](remote-exposure.md) | Threat model, proxy recipes, operator checklist for going beyond loopback |
| [Dogfooding](dogfooding.md) | Live-account runbook |
| [Security policy](../SECURITY.md) | Private vulnerability reporting. Do not open a public issue for a security problem. |
| [Changelog](../CHANGELOG.md) | Versioning policy and release history |

## Contributor docs

| Document | What it covers |
|---|---|
| [Developing oh-my-agent](develop/README.md) | Contributor hub: first hour, modules, tests, delivery tree |
| [Architecture](../ARCHITECTURE.md) | Design specification with implementation markers |
| [Contributing](../CONTRIBUTING.md) | Setup, test-first rules, PR evidence |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Community rules |
| [Root README](../README.md) | Install, development commands, license |
| [Delivery tree](delivery/README.md) | Generated task tree. Author in `scripts/gen-delivery-docs.py`, never hand-edit `docs/delivery/`. |
| [Release](develop/release.md) | Manual changelog cut, GitHub Release, npm publish |
| [ADRs](delivery/adr/) | Decision records, including the alternatives that lost |
| [Diagrams](diagrams/README.md) | Archify JSON sources and rendered SVGs |

## Diagrams

JSON is the source. Markdown embeds the committed SVG. Do not hand-edit SVG or paste mermaid for these maps.

| Diagram | File |
|---|---|
| Index | [diagrams/README.md](diagrams/README.md) |
| Runtime | [runtime.svg](diagrams/runtime.svg) |
| First run | [first-run.svg](diagrams/first-run.svg) |
| Mention wakeup | [mention-wakeup.svg](diagrams/mention-wakeup.svg) |
| Worker lifecycle | [worker-lifecycle.svg](diagrams/worker-lifecycle.svg) |
| Credential path | [credential-path.svg](diagrams/credential-path.svg) |
| Isolation | [isolation.svg](diagrams/isolation.svg) |

## Requirements

- [Bun](https://bun.sh) >= 1.3.14
- [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` >= 18.0.7) as a peer

Package: `@bloodf/oh-my-agent` 1.0.1. Binary: `omp-agent`. License: [MIT](../LICENSE).
