# CLI

`omp-agent` talks JSON-RPC over the daemon's unix socket. It does not need an OMP session or TUI. The TUI already auto-starts the daemon on session start and exposes the same verbs as `/cli <verb>` and `/console`, so PATH is not required.

Binary: `src/daemon/main.ts`, installed as `omp-agent` at `~/.omp/plugins/node_modules/.bin/omp-agent`. Call that path, or stay in the TUI. Override the profile with `PI_CODING_AGENT_DIR`.

Related: [Getting started](getting-started.md), [Concepts](concepts.md), [Agents](agents.md).

## Invocation

```
Usage: omp-agent [--json] <verb> [args]

Flags come before the verb; anything after `--` is payload, so a literal
--json inside a message is never eaten. Errors are always plain text,
never JSON.
```

That block is the USAGE header. A parse error prints it plus the Verbs list and exits 2.

`omp-agent` with **no arguments** is `omp-agent daemon`, not usage. It starts the daemon.

| Flag | Meaning |
|---|---|
| `--json` | Print the protocol result as JSON on stdout. Must appear before the verb. |
| `--` | End flag parsing. Everything after is payload. |

`--json` never applies to errors. Failures are always plain text on stderr.

`omp-agent console` always prints a plain-text URL, even if `--json` is passed.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | Usage error. Prints `Usage: ...` |
| 3 | Daemon not running |
| 4 | Daemon RPC error, unreadable file, parser refusal, or other operator-facing failure |

Daemon-down sentence (exit 3), exact:

```
oh-my-agent daemon not running — start it with `omp-agent daemon`.
```

## Verbs

### status

```sh
omp-agent status
omp-agent --json status
```

Human output:

```
protocol: 1
uptime: <ms>ms
agents: <n>
```

JSON: `{ protocolVersion, agents, uptimeMs }`.

### audit

```sh
omp-agent audit
omp-agent --json audit
```

Live authenticated connections. First line is `trust model: loopback` or `trust model: remote`. Each row is identity, class (`control-socket`, `console-loopback`, `console-proxied`), source, time. Operator token, proxy secret, and tickets are omitted. See [Remote exposure](../remote-exposure.md).

### agents

```sh
omp-agent agents
```

One live peer per line: `name`, `state` (`running` \| `parked` \| `stopped`), `account`, optional `parent=` and `children=`.

### agent create

```sh
omp-agent agent create <name> <file|->
```

Author a definition without starting it. `<file>` is a markdown document. `-` reads stdin.

Rules:

- Frontmatter `name:` must equal `<name>`
- Only keys `name`, `description`, `model`, `rooms`, `wake`, `autonomy`, `spawns`, `body`
- Other authored keys are refused, not dropped. Set them with `agent edit`
- Never spawns

Human: `<name>	created` or `<name>	unchanged`.

### agent show

```sh
omp-agent agent show <name>
```

Prints the file path, then the definition as JSON. `--json` prints `{ name, definition, filePath }`.

### agent edit

```sh
omp-agent agent edit <name> <file|->
```

`<file>` is a **JSON object of changed fields**, not markdown. Unknown keys are refused, not dropped.

Human: `<name>	rebuild-required` or `<name>	live`.

### spawn

```sh
omp-agent spawn <name>
omp-agent spawn <name> --parent <parent>
```

Start a stored definition. `--parent` is optional spawn-time metadata. The parent must be live. Children inherit the parent's account and `#<parent>-team`. Human: `<name>	<state>`.

### kill

```sh
omp-agent kill <name>
omp-agent kill <name> --keep-children
```

Default: stop the peer and cascade down its subtree. `--keep-children` reparents those children to root and leaves them running. Human: `<name>	stopped`.

### rooms

```sh
omp-agent rooms
omp-agent rooms read <room>
omp-agent rooms post <room> <text...>
```

| Form | Output |
|---|---|
| `rooms` | `id	kind	name` per room. `kind` is `channel` or `dm`. |
| `rooms read <room>` | `id	author	body` per message |
| `rooms post <room> <text...>` | `message: <id>` |

Posts as `@you`. `<text...>` is joined with spaces. A literal `--json` in the message is payload if it comes after the verb, or after `--`. More: [Rooms](rooms.md).

### schedule

```sh
omp-agent schedule
omp-agent schedule <id> on
omp-agent schedule <id> off
```

List: `id	on|off	<cron or action>`. Arm: `<id>	on` or `<id>	off`.

Ids are runtime values: `<peer>:schedule:<index>` and `<peer>:automation:<index>`. Automations have no cron timer.

### logs

```sh
omp-agent logs <name> [n]
omp-agent logs daemon [n]
```

Stderr tail. Default `n` is 50. `n` must be a positive integer. The selector `daemon` is literal: it reads the daemon log, even if a peer happens to be named `daemon`.

### inject

```sh
omp-agent inject <name> <text...>
```

Push an instruction into the peer's next turn. Running: sent now. Parked: queued into a subscribed room. Stopped: refused. Human: `<name>	sent` or `<name>	queued`.

### bump

```sh
omp-agent bump <account> <usd>
```

Raise a metered account's ceiling and resume parked peers. `<account>` is the provider key from `model:` (for `anthropic/claude-sonnet-4-5`, use `anthropic`). `<usd>` must be a positive finite number. Human: `<account>	<usd>`. JSON also includes `resumed: string[]`.

### console

```sh
omp-agent console
```

Reprint the console URL from `<agent-dir>/oh-my-agent/console-url`. Always plain text. If the daemon is headless (`OMA_CONSOLE=0`), the error is `oh-my-agent console is disabled for this daemon.` See [Console](console.md).

### daemon

```sh
omp-agent daemon
omp-agent daemon --worker-backend rpc
omp-agent daemon --worker-backend in-process
omp-agent --json daemon
omp-agent daemon stop
omp-agent daemon restart
```

| Form | Effect |
|---|---|
| `daemon` | Start detached. Default worker backend is `rpc`. Prints socket path, then console URL. |
| `--worker-backend rpc` | Subprocess workers (default). Required for the OS sandbox. |
| `--worker-backend in-process` | Embed sessions in the daemon. Not OS-sandboxed. |
| `daemon stop` | RPC stop, then wait until the pidfile is gone (15s deadline). Human: `stopped	<pid>`. |
| `daemon restart` | Stop, then launch the same binary. Human: `restarted	<socket>`. |

`--json` on start prints `{ socket, consoleUrl, workerBackend }`. `--worker-backend` is only valid on start, immediately after `daemon`.

## `--json` notes

- Place `--json` before the verb: `omp-agent --json status`, not `omp-agent status --json`.
- Errors stay plain text. Scripts should branch on exit code, then parse stdout only on 0.
- `console` ignores `--json`.
- `agent show` without `--json` already prints JSON for the definition body. `--json` wraps the whole result.

## TUI counterparts

Inside `omp`, after the extension loads:

| Slash command | CLI equivalent |
|---|---|
| `/agents` | `omp-agent agents` |
| `/spawn <name>` | `omp-agent spawn <name>` |
| `/kill <name>` | `omp-agent kill <name>` |
| `/rooms read <room>` | `omp-agent rooms read <room>` |
| `/rooms post <room> <message>` | `omp-agent rooms post <room> <message>` |
| `/schedule` | `omp-agent schedule` |
| `/schedule <id> on\|off` | `omp-agent schedule <id> on\|off` |
| `/logs <name> [n]` | `omp-agent logs <name> [n]` |
| `/inject <name> <message>` | `omp-agent inject <name> <message>` |
| `/manage` (shortcut `Ctrl+G`) | Full-screen manager; no CLI equivalent |

The status widget shows `agents: N running, M parked · rooms: K unread`. If the daemon is down, it shows the same daemon-down sentence as the CLI.
