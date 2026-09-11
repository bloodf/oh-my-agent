# Getting started

![oh-my-agent](../assets/logo.png)

![First run](../diagrams/first-run.svg)

From install to a spawned example agent and a room post. Assumes [Bun](https://bun.sh) >= 1.3.14 and [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` >= 18.1.0) are already installed, and that OMP can already call the model you put in the definition.

If a term is new, skim [Concepts](concepts.md) after this page.

## 1. Install the plugin

```sh
omp install @bloodf/oh-my-agent
```

## 2. Open the TUI

```sh
omp
```

Session start starts the detached daemon from the plugin tree. No PATH. No extra `omp-agent daemon`. Widget should show `oh-my-agent · 0 running · 0 parked · 0 unread · /manage`, drawn in your OMP theme and symbol preset. `/manage` opens the manager.

Inside the TUI:

```
/cli status
/console
```

`/cli` is every `omp-agent` verb. `/console` opens **Open web UI**, **Copy URL**, and **Show URL**. **Show URL** deliberately reveals the operator token; use `/cli console` when you need explicit URL output. That is the full operator web UI.

The daemon keeps running after you close the TUI. Closing the terminal does not stop it.

Shell CLI is optional. No PATH export required if you use the full path:

```sh
~/.omp/plugins/node_modules/.bin/omp-agent status
```

Expected shape:

```
protocol: 1
uptime: <milliseconds>ms
agents: 0
```

`omp-agent console` reprints the loopback URL, including the operator token. If the daemon is not running, every CLI verb prints this sentence and exits 3:

```
oh-my-agent daemon not running — start it with `omp-agent daemon`.
```

The TUI already tried to start it. That sentence means the auto-start failed; run `omp-agent daemon` from PATH as the fallback.

## The default team

The daemon seeds four peers into `~/.omp/agent/oh-my-agent/agents/` on its first boot and starts them: `staff-pm` (`#product`), `staff-backend` (`#backend`), `staff-frontend` (`#frontend`), and `staff-qa` (`#qa`), all also in `#team`. They declare no model, so they run on OMP's default model role, the one `/model` sets. `omp-agent agents` shows the model each one is actually on.

```
/rooms post #team @staff-pm scope a login page with email and password
```

To put one on a different model, `/edit staff-backend` → Model. The picker lists every model the daemon's credentials can reach, with the default marked; `omp-agent models` prints the same list. The seed is offered once: a definition you edit is never overwritten, and one you delete is not recreated.

If a staff peer shows `stopped` with an error naming OMP's default model, the daemon cannot route to that model: it only routes providers in `~/.omp/agent/models.yml` and broker credentials, not ones a TUI extension adds. Add the provider to `models.yml`, or pick a listed model with `/edit <name>` → Model.

The rest of this guide writes a peer of your own.

## 3. Install the native scout

The researcher restricts temporary subagents to `scout`. Native task-agent definitions are separate from persistent oh-my-agent peers, and the npm package does not ship one. Create this read-only native definition before spawning researcher:

```sh
mkdir -p ~/.omp/agent/agents
cat >~/.omp/agent/agents/scout.md <<'EOF'
---
name: scout
description: Read-only code locator. Returns file:line citations.
model: "@task"
tools: [read, grep, glob]
---

You are a read-only scout. Locate the requested code, return path:line citations only, never suggest fixes, never edit.
EOF
```

Keep researcher's `spawns: [scout]` allowlist; do not replace it with `"*"`.

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

Same from the TUI: `/cli agent create researcher researcher.md`.

Expected:

```
researcher	created
```

The file is written to `<daemon-project>/.omp/oh-my-agent/agents/researcher.md`, where daemon-project is the cwd of the daemon process (the directory you launched `omp` from, or the cwd of a manual `omp-agent daemon`), not the CLI cwd. It is not written to OMP's global `~/.omp/agent/agents/` root.

## 5. Spawn it

```sh
omp-agent spawn researcher
```

Same from the TUI: `/spawn researcher` or `/cli spawn researcher`.

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
omp-agent rooms post '#research' @researcher Look up how omp-agent spawn differs from native task.
```

Expected:

```
message: <id>
```

You post as `@you`. With `wake.mention: true` and `wake.rooms: true`, the researcher wakes on that post.

Read the transcript:

```sh
omp-agent rooms read '#research'
```

Open the same conversation in the browser:

```sh
omp-agent console
```

Paste the printed URL. Details: [Console](console.md).

From the OMP TUI, the same actions are `/cli agents`, `/spawn researcher`, `/rooms post #research ...`, `/rooms read #research`. The status widget shows running and parked counts. The native OMP `/agents` is the built-in task-agent hub and is unrelated to oh-my-agent peers.

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
