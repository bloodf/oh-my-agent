# Support

oh-my-agent is a local OMP plugin maintained without a support contract. Questions and defects are handled in public GitHub issues when they are not security or conduct reports.

## Where to ask

Open an issue on [bloodf/oh-my-agent](https://github.com/bloodf/oh-my-agent/issues).

Use the templates:

- **Bug report** for behavior that differs from the docs.
- **Feature request** for new behavior. Requests are added by the maintainer in [`scripts/gen-delivery-docs.py`](scripts/gen-delivery-docs.py), then `bun run docs`. Do not hand-edit [`docs/delivery/`](docs/delivery/README.md).

Search existing issues first. A question that shows the docs were unclear is a docs bug; file it as one.

## What to include

For a bug:

- What you observed and what you expected.
- Exact commands, not a paraphrase.
- `bun --version`, `omp --version`, and `git rev-parse --short HEAD` (or the installed package version).
- Which surface: daemon, CLI, browser console, TUI extension, workers, rooms, packaging.
- Trust mode printed at boot (`trust model: loopback` or `trust model: remote`).
- Relevant stderr. **Redact tokens.** Anything after `?token=`, an `Authorization` header, or `X-Operator-Token` is a live credential.

The bug template collects this. Fill it.

## Security, conduct, bugs

These are three different queues. Do not mix them.

| Kind | Where | Do not |
|---|---|---|
| Vulnerability | Private advisory: [Report a vulnerability](https://github.com/bloodf/oh-my-agent/security/advisories/new). Policy: [`SECURITY.md`](SECURITY.md). | Open a public issue, gist, or discussion. |
| Conduct | Maintainer [@bloodf](https://github.com/bloodf) by GitHub direct message, or an issue if the matter is not sensitive. Policy: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). | Use the security advisory form. That queue is for vulnerabilities. |
| Bug or question | Public issue, using the templates. | File a security advisory for a crash, a docs gap, or a feature idea. |

## Docs

Read these before filing, and link the one you followed:

| Doc | When |
|---|---|
| [`docs/guide/getting-started.md`](docs/guide/getting-started.md) | Install, first daemon, first agent |
| [`docs/guide/cli.md`](docs/guide/cli.md) | `omp-agent` verbs |
| [`docs/web-console.md`](docs/web-console.md) | Browser console, token, loopback URL |
| [`docs/remote-exposure.md`](docs/remote-exposure.md) | Anything beyond loopback |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the daemon, workers, and rooms fit |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Checkout, tests, evidence for a PR |
| [`docs/develop/README.md`](docs/develop/README.md) | Developer map |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Who maintains this and how changes land |

Only the latest release and `main` receive fixes. There are no backports.
