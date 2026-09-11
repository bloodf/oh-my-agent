---
name: oh-my-agent-setup
description: Set up and configure oh-my-agent for this operator — run the checklist, read each ✗ line, apply the fix it names, and hand over a working crew that answers in #bridge.
---

# Setting up oh-my-agent

You are helping the operator get oh-my-agent working inside OMP. The plugin ships a checklist; your job is to run it, explain each failing line in one sentence, and apply or dictate the fix. Do not describe the architecture unless asked. Stop when `/setup` prints `✓ ready`.

## 1. Run the checklist

Ask the operator to run `/setup` in the TUI (or run `omp-agent setup` yourself if you have a shell). It prints one line per check, `✓` or `✗`, each `✗` ending with the command that fixes it:

| Line | Meaning | Fix |
|---|---|---|
| `✗ daemon: …` | The daemon is not reachable. | `/cli daemon restart`. If it says "already running", the socket or token file is stale: `/cli daemon restart` again; then `omp-agent daemon stop` from a shell. |
| `✗ daemon X is older than this plugin Y` | The daemon predates the installed plugin. | `/cli daemon restart`. |
| `✗ no model the daemon can route to` | No provider credential the daemon can use. | Log into a provider in OMP (`/login`), or add the provider to `~/.omp/agent/models.yml`. Then `/cli daemon restart`. |
| `✗ no OMP default model` | OMP has no default model role. | `/model` and pick one. Then `/cli daemon restart`. |
| `✗ OMP default X is not routable by the daemon` | The TUI's default comes from an extension the daemon cannot route (a TUI-only provider). | `/setup` offers a picker: choose a listed model and it is written to every crew peer still on the default. Or add the provider to `models.yml`. |
| `✗ <peer> stopped: …` | A crew peer failed to start; the reason follows. | Fix the reason (usually the model line above), then `/setup` offers to start them, or `/spawn <peer>`. |
| `✗ missing: …` | The default crew was never seeded, or was deleted. | `/cli daemon restart` seeds once. To recreate one by hand: `/preset` does not ship the staff, so `/cli agent create <name> <file>` with a definition, or accept the seed. |
| `✗ rooms missing` | `#bridge` or `#team` does not exist yet. | `/rooms create #bridge` (they also appear when the crew starts). |

## 2. Confirm it works

Post a small request and watch the reactions:

```
/rooms post #bridge @mate say hello and tell me who is on the crew
/rooms read #bridge
```

The mate's 👀 appears on the message when it was delivered, ⏳ while it works, ✅ when its turn ends. If no reaction appears within a minute, `/logs mate 50` shows the worker's output; a model error there means the model line in `/setup` is still wrong.

## 3. Configure to taste

- **Models per peer**: `/edit <peer>` → Model lists everything the daemon can route to, with the default marked. `omp-agent models` prints the same.
- **More roles**: `/preset` lists ten shipped roles (researcher, reviewer, security-reviewer, tech-writer, sre, debugger, test-engineer, designer, release-manager, data-analyst). `/preset <role> <name>` copies one; `/spawn <name>` starts it.
- **Channels**: `/rooms create #topic`, then `/rooms join #topic <peer>`, or just `@mention` the peer there: a mention invites it and hands it the room's history.
- **Web console**: `/console` → Open web UI. Same daemon, same rooms.
- **Restart open sessions** after a plugin upgrade so the TUI loads the new commands, then `/cli daemon restart` so the daemon matches.

## 4. What not to do

- Do not edit files under `~/.omp/agent/oh-my-agent/` by hand while the daemon runs; use `/edit`, `/rooms join`, or the console, which apply changes live.
- Do not spawn a second copy of a running peer to get its attention; post in a room it is in.
- Do not print the console token. `/console` → Copy URL copies it without showing it.
