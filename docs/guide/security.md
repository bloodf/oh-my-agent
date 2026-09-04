# Security

The daemon binds loopback only, in every mode, unconditionally. Treat that as the product default, not a setting you can turn off.

This page is the newcomer model. The enforcement table and proxy recipes live in [Remote exposure](../remote-exposure.md). The reporting process lives in [SECURITY.md](../../SECURITY.md).

## Loopback default

Three listeners exist: the unix control socket, the console HTTP/WebSocket, and the credential gateway. All stay on this machine.

- Console HTTP binds `127.0.0.1`
- Credential gateway binds `127.0.0.1`
- `OMA_CONSOLE_HOST`, `OMA_CONTROL_HOST`, and `OMA_CREDENTIAL_GATEWAY_HOST` are refused if they are not loopback, **with or without** `OMA_REMOTE`

There is no `--host 0.0.0.0`. Going beyond loopback means a reverse proxy in front of the loopback console, plus an explicit remote mode. Follow [Remote exposure](../remote-exposure.md) before exposing anything. Do not forward the credential gateway.

## Operator token

The console and the control socket require the operator token.

| File | Mode | Role |
|---|---|---|
| `<agent-dir>/oh-my-agent/console-token` | 0600 | Long-lived operator bearer |
| `<agent-dir>/oh-my-agent/console-url` | 0600 | URL `omp-agent console` reprints (loopback URLs include `?token=`) |

A token file that is not 0600 fails the boot and names the path. The daemon does not silently replace it.

Rotate by stopping the daemon, deleting `console-token`, and starting again.

One operator per daemon. There is no user model and no cross-operator isolation. Do not treat the token as a per-user credential. Do not share it.

Worker bearers are scoped. They may call worker methods. They cannot `kill`, `status` as operator, or otherwise use operator surfaces. Operator auth grants console and control authority, never a provider credential.

![Credential path](../diagrams/credential-path.svg)

## Sandbox honesty

**`workspace:` is not a sandbox.** It is the worker's `cwd`. It does not stop the agent reading `~/.ssh` or `/etc/passwd`. OMP tools run with your user permissions.

The only real filesystem boundary is the opt-in OS sandbox:

```yaml
sandbox: true
# or
sandbox: { enabled: true, extraRoots: ["/absolute/path"] }
```

That wraps the **RPC** subprocess: macOS Seatbelt, Linux `bwrap`. If the adapter is missing, launch fails closed. The in-process backend (`omp-agent daemon --worker-backend in-process`) is not sandboxed. Use RPC when isolation matters.

`/agents` shows a shield only when `sandboxed` is actually true. Claiming a sandbox the worker does not run under would be a false security claim.

![Isolation](../diagrams/isolation.svg)

Tool allowlists and generated worker roots reduce accidents. They are not a security boundary. See [Concepts](concepts.md) and [ARCHITECTURE.md §7](../../ARCHITECTURE.md).

## Credentials and quota

Workers never receive the vault-wide broker token. Each worker gets a scoped gateway bearer bound to one account. The gateway stays on loopback.

Metered accounts warn at 80% of `budgetUsd` and park at 100%. Subscription accounts park on quota-exhaustion and auto-resume. A parked account refuses wakes so it does not burn a turn that would fail. Raise a metered ceiling with `omp-agent bump <account> <usd>` (strictly positive).

## Remote mode in one paragraph

`OMA_REMOTE=1` changes what a request must carry, never where the daemon listens. A console in remote mode requires `OMA_CONSOLE_ORIGIN` (HTTPS origin, no credentials or path). Static assets and the WebSocket upgrade use one-time, path-bound tickets with a 30s TTL. Parentage is enforced against caller identity. Audit live connections with `omp-agent audit`. If any of that is unclear, stop and read [Remote exposure](../remote-exposure.md) instead of improvising a bind.

## Report a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub private reporting: [Report a vulnerability](https://github.com/bloodf/oh-my-agent/security/advisories/new).

Include what an attacker can do, what they need first (local user, loopback, a valid token, a compromised proxy), reproduction steps, and the commit or version. Full policy: [SECURITY.md](../../SECURITY.md).

Next: [FAQ](faq.md), [Remote exposure](../remote-exposure.md).
