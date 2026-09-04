# oh-my-agent

[![CI](https://github.com/bloodf/oh-my-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/bloodf/oh-my-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A5%201.3.14-black)](https://bun.sh)

An [oh-my-pi (OMP)](https://omp.sh/docs) plugin that runs **autonomous, long-lived
agents**. They keep working while you're away, talk to each other in persistent chat
rooms, and stay observable and steerable from the OMP TUI, a browser console, or a shell.

> **1.0.0 release.** `@bloodf/oh-my-agent` packages the complete runtime and operator
> surfaces for installation through OMP. Development from a checkout remains documented
> in [Development](#development).

## What it does

You define an agent as markdown with YAML frontmatter, the same way OMP task agents are
defined. The daemon then runs it as a supervised process that outlives your terminal.

- **Autonomy** — agents run without a TUI attached; closing your terminal does not stop them.
- **Collaboration** — agents talk in persistent channels and DMs, waking on mentions.
- **Hierarchy** — agents can author and deploy child agents, with parentage enforced.
- **Scheduling** — cron-style automations spawn or wake agents on their own.
- **Quota handling** — a metered account that hits its ceiling parks its agents and
  arms an unattended resume, rather than failing loudly at 3am.
- **Isolation** — each worker gets a private root containing only the definitions it is
  allowed to see, with an opt-in OS sandbox and per-worker scoped credentials.

Three ways to drive it: the OMP TUI extension, the `omp-agent` CLI, and a browser console.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3.14
- [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` ≥ 18.0.7) as a peer

## Install and quickstart

The 1.0.0 release installs into OMP with these five commands, which load its extension,
start the daemon, verify its status, and print the browser-console URL:

```sh
omp install @bloodf/oh-my-agent
omp
~/.omp/plugins/node_modules/.bin/omp-agent daemon
~/.omp/plugins/node_modules/.bin/omp-agent status
~/.omp/plugins/node_modules/.bin/omp-agent console
```

Exit the OMP TUI after confirming the `oh-my-agent` extension loaded, then run the
remaining commands. Open the URL printed by the final command.

This path is exercised on every CI run against a packed tarball, in
[`tests/consumer-install.test.ts`](tests/consumer-install.test.ts) — npm, Bun, and the
OMP installer, each booting the daemon through the installed shim.

## Documentation

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The design specification, with per-section implementation markers |
| [`docs/delivery/`](docs/delivery/README.md) | The authoritative task tree: every unit of work, with status and evidence |
| [`docs/delivery/adr/`](docs/delivery/adr/) | 15 decision records, each with the alternatives that lost |
| [`docs/web-console.md`](docs/web-console.md) | The browser console |
| [`docs/remote-exposure.md`](docs/remote-exposure.md) | Threat model, proxy recipes, and the operator checklist for going beyond loopback |
| [`docs/dogfooding.md`](docs/dogfooding.md) | The live-session runbook |
| [`CHANGELOG.md`](CHANGELOG.md) | Versioning policy and release history |

## Security

The daemon binds loopback only, in every mode, unconditionally. Going beyond loopback
means a proxy in front and an explicit remote mode, with an operator token, one-time
tickets for assets and WebSocket upgrades, and enforced parentage.

Read [`docs/remote-exposure.md`](docs/remote-exposure.md) before exposing anything, and
[`SECURITY.md`](SECURITY.md) to report a vulnerability. **Do not open a public issue for
a security problem.**

## Development

```sh
git clone https://github.com/bloodf/oh-my-agent.git
cd oh-my-agent
bun install

bun run typecheck   # tsc --noEmit
bun test            # unit, integration, browser, and OMP contract suites
bun run lint        # biome check .
bun run docs        # regenerate docs/delivery (edit the generator, never the output)
```

`bun run test:fast` skips the three slowest suites while you iterate.

Working rules: test-first with non-vacuity proofs, tests call production builders, and
every unit of work is a task file in the delivery tree.

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the
testing standards, and what evidence a PR needs. Two rules are worth knowing up front:

1. **`docs/delivery/` is generated.** Author in `scripts/gen-delivery-docs.py`.
2. **Every new test needs a non-vacuity proof** — revert the line it covers, watch it
   fail, restore it. A test that cannot fail is not evidence.

Anything marked **Ready** in the [delivery tree](docs/delivery/README.md) is specified
and unblocked. Please read [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) too.

## License

[MIT](LICENSE) — see [ADR-010](docs/delivery/adr/ADR-010-mit-license.md) for the
decision record.
