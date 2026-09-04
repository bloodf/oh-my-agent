# Getting started

![oh-my-agent](../assets/logo.png)

![First run](../diagrams/first-run.svg)

Five minutes from install to a spawned example agent and a room post. Assumes [Bun](https://bun.sh) >= 1.3.14 and [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` >= 18.0.7) are already installed, and that OMP can already call the model you put in the definition.

If a term is new, skim [Concepts](concepts.md) after this page.

## 1. Install the plugin

```sh
omp install @bloodf/oh-my-agent
```

The binary lands at:

```sh
~/.omp/plugins/node_modules/.bin/omp-agent
```

Put that directory on `PATH`, or alias it for this session:

```sh
export PATH="$HOME/.omp/plugins/node_modules/.bin:$PATH"
```

The rest of this guide calls `omp-agent`. If the command is not found, use the full path.

## 2. Confirm the TUI extension

```sh
omp
```

Confirm the `oh-my-agent` extension loaded, then exit the TUI. The daemon is a separate process. Closing OMP does not start it.

## 3. Start the daemon

```sh
omp-agent daemon
```

The launcher prints two lines and exits. The daemon keeps running detached:

```
/Users/you/.omp/agent/oh-my-agent/daemon.sock
http://127.0.0.1:50561/?token=<operator-token>
```

The first line is the control socket. The second is the browser console URL, including the operator token. Save it, or reprint it later with `omp-agent console`.

Verify:

```sh
omp-agent status
```

Expected shape:

```
protocol: 1
uptime: <milliseconds>ms
agents: 0
```

If the daemon is not running, every other verb prints this sentence and exits 3:

```
oh-my-agent daemon not running — start it with `omp-agent daemon`.
```

## 4. Create the example researcher

`agent create` stores a definition. It does not start a worker. It accepts only a subset of frontmatter keys: `name`, `description`, `model`, `rooms`, `wake`, `autonomy`, `spawns`, plus the markdown body. See [Agents](agents.md) for the rest.

Write this file. `model` must be a fully qualified `provider/id` that OMP already has credentials for. `@role` aliases such as `@task` are not resolved for peers.

```markdown
---
name: researcher
description: Investigates technical questions and posts source-backed findings to the research room.
model: "anthropic/claude-sonnet-4-5"
spawns: [scout]
rooms: ["#research"]
wake: { mention: true, rooms: true }
autonomy: { maxTurns: 30, budgetUsd: 1.5 }
---
You are the team's technical researcher. Investigate requests from #research, prefer primary sources, distinguish verified facts from inference, and post concise findings with citations. Delegate bounded codebase searches to scout.
```

This matches [`agents/example-researcher.md`](../../agents/example-researcher.md) in the git checkout: same frontmatter and body. The git file also has an HTML comment that `agent create` ignores. The published npm package does not ship that directory, so paste the document yourself.

Create it. The command name must match `name:` in the frontmatter. `-` reads stdin instead of a path.

```sh
omp-agent agent create researcher researcher.md
```

Expected:

```
researcher	created
```

The file is written to `<daemon-project>/.omp/oh-my-agent/agents/researcher.md`, where daemon-project is the cwd of `omp-agent daemon`, not the CLI cwd. It is not written to OMP's global `~/.omp/agent/agents/` root.

## 5. Spawn it

```sh
omp-agent spawn researcher
```

Expected:

```
researcher	running
```

Spawn starts a supervised worker from the stored definition. The worker's `cwd` is the project you launched the daemon from. `#research` is created if it does not exist, and the peer is subscribed.

List live peers:

```sh
omp-agent agents
```

## 6. Post to the room

```sh
omp-agent rooms post #research @researcher Look up how omp-agent spawn differs from native task.
```

Expected:

```
message: <id>
```

You post as `@you`. With `wake.mention: true` and `wake.rooms: true`, the researcher wakes on that post.

Read the transcript:

```sh
omp-agent rooms read #research
```

Open the same conversation in the browser:

```sh
omp-agent console
```

Paste the printed URL. Details: [Console](console.md).

From the OMP TUI, the same actions are `/agents`, `/spawn researcher`, `/rooms post #research ...`, `/rooms read #research`. The status widget shows running and parked counts.

## Stop and next

```sh
omp-agent kill researcher
omp-agent daemon stop
```

`kill` stops the worker. `daemon stop` stops the daemon. Closing the terminal does not.

Next:

- [Concepts](concepts.md) - how the pieces fit
- [Agents](agents.md) - full frontmatter and first-timer errors
- [CLI](cli.md) - every verb
- [Rooms](rooms.md) - channels, DMs, wake
- [Security](security.md) - loopback, token, sandbox
