---
name: omp-subagent-authoring
description: Author native OMP task agents — temporary in-run subagents for bounded coding/research subtasks, their file format, and the spawns policy that governs them.
---

# Authoring native task agents

A native task agent is **temporary and in-run**: spawned by the `task` tool, bounded to the parent's run, its transcript folds back into the parent when it yields. This is the ONLY temporary-subagent path (ADR-007) — peers never use `agent_spawn` for subtasks.

## File format

One markdown file, YAML frontmatter plus body (the body becomes `systemPrompt`). Discovered from the agent dir (`~/.omp/agent/agents/`), project `.omp/agents/`, and extension packages. Parser: OMP's `parseAgent` (`@oh-my-pi/pi-coding-agent/task/agents`).

| Key | Type | Meaning |
|---|---|---|
| `name` | string | Required. Dispatch name. |
| `description` | string | Required. Shown to the dispatcher when it picks an agent. |
| `model` | string \| string[] | e.g. `"@task"`, `"anthropic/claude-sonnet-4-5"`. |
| `tools` | string[] | Restricted tool list; `task` is auto-added when `spawns` is declared. |
| `spawns` | string \| string[] | CSV or array of agents this one may spawn; `"*"` = any. |
| `thinkingLevel` | string | Reasoning effort. |
| `output` | object | Structured-output schema for the yield. |
| `blocking` | boolean | Whether the dispatch blocks the parent. |
| `autoloadSkills` | string[] | Skills loaded into the subagent's prompt. |
| `readSummarize` | boolean | `false` = verbatim `read` output instead of structural summaries. |
| `prewalk` | boolean \| string | Pre-walk hand-off model. |
| `advisor` | boolean \| string | Advisor model for spawned sessions. |

## Worked example

```markdown
---
name: scout
description: Read-only code locator. Returns file:line citations.
model: "@task"
tools: [read, grep, glob]
---

You are a read-only scout. Locate the requested code, return
path:line citations only, never suggest fixes, never edit.
```

Dispatch from the parent:

```json
{ "tasks": [{ "agent": "scout", "task": "Find where materializeWorker writes skills" }] }
```

## Spawns policy

- A caller's `spawns:` list is the allowlist at dispatch time; an omitted `agent` field defaults to the first entry.
- Depth is capped by `task.maxRecursionDepth` (default 2); at the cap OMP strips `task` and empties the spawn policy, so deep subagents cannot spawn.
- Per-agent bans come from `task.disabledAgents` — oh-my-agent's materializer writes every discovered name outside a worker's allowlist there as defense-in-depth.
- Self-recursion is blocked by the `PI_BLOCKED_AGENT` guard.

## When temporary is RIGHT

Use a task agent when the work is:

- **Bounded** — a coding fix, a research pass, a review with a defined end.
- **In-run** — its output matters to this run only; nothing to persist.
- **Delegable** — the parent coordinates and needs the transcript back.

Reach for a persistent peer (see `omp-orchestration`) instead when the work must survive the run: own rooms, own schedule, its own lifecycle.

## First-timer failure modes

- **Missing `description`** — the agent won't be picked up cleanly; name + description are the discovery contract.
- **Editing `~/.omp/agent/agents/` for a peer** — that root is global to every OMP session. Peer definitions live in the oh-my-agent private store instead (see `omp-agent-authoring`); only true shared subagents belong in global roots.
- **Expecting state across runs** — task agents are rebuilt per dispatch. Nothing carries over; pass everything in the `task` text.
- **Dispatching `agent_spawn` for a subtask** — the worker toolbelt rejects spawn calls without a non-empty `rooms` array; `expected_output` signals one-shot intent. Temporary work goes through `task`, always.
- **Restricted `tools:` without `spawns:`** — fine for a leaf agent, but it silently cannot delegate; if it should delegate, declare `spawns`.
