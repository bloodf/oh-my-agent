---
name: omp-agent-authoring
description: Author an oh-my-agent peer definition — every frontmatter key, the strict parser's rejection codes, and runtime creation via agent_create / agent_spawn.
---

# Authoring a peer definition

A peer definition is one markdown file: YAML frontmatter plus a body. The body is the peer's standing instructions; the frontmatter is validated by a strict parser (`parsePeerDefinition` in `src/shared/agent-definition.ts`) that **throws on any key it does not know** — a typo is never silently ignored.

## Frontmatter field reference

### Native OMP keys (validated by OMP's `parseAgent`)

| Key | Type | Notes |
|---|---|---|
| `name` | string | Required. The peer's identity. |
| `description` | string | Required. One line, what it does. |
| `model` | string | e.g. `"anthropic/claude-sonnet-4-5"`, `"@review"` (model-role alias), or `"@task"`. |
| `tools` | string[] | **Replaces** the default set. A restricted list gets `task` appended automatically by the parser, so delegation always survives. |
| `spawns` | `"*"` \| string \| string[] | **Required** by oh-my-agent. In-run subagent allowlist. `"*"` = any; a CSV string or array = allowlist. Missing → `MISSING_SPAWNS`; empty string/array → `EMPTY_SPAWNS`. |
| `thinking` / `thinkingLevel` | string | Reasoning effort override. |
| `output` | object | Structured-output schema for the final yield. |
| `blocking` | boolean | Whether dispatches to this agent block. |
| `autoloadSkills` | boolean | Load discovered skills into the system prompt. |
| `readSummarize` | object | Read-summarization behavior. |
| `prewalk` | object | Pre-run context walk. |
| `advisor` | object | Advisor model configuration. |

### oh-my-agent extension keys

| Key | Type | Rejects with |
|---|---|---|
| `workspace` | absolute path string | `INVALID_WORKSPACE` — must be a string and `isAbsolute()`. `~/work` fails: expand it yourself. |
| `rooms` | string[] | `INVALID_ROOM` — must be an array of strings, each starting with `#` (channel) or `@` (DM). |
| `wake` | object | `INVALID_WAKE` — plain object, only keys `mention` and `rooms`, both boolean. |
| `autonomy` | object | `INVALID_AUTONOMY` — only keys `maxTurns` (positive **integer**) and `budgetUsd` (positive **finite** number). |
| `sandbox` | boolean \| object | `INVALID_SANDBOX` — `true`/`false`, or an object with only `enabled` (boolean) and `extraRoots` (array of **absolute** paths; a relative entry throws `INVALID_WORKSPACE`). |
| `mcps` | string[] | `INVALID_ARRAY` — must be a string array. |
| `skills` | string[] | `INVALID_ARRAY` — names of skills to materialize into the worker root (e.g. `omp-orchestration`). |
| `schedules` | object[] | `INVALID_SCHEDULE` — each item needs non-empty `cron` and `prompt`; optional `room` must start with `#`/`@` (else `INVALID_ROOM`). Only keys `cron`, `prompt`, `room`. |
| `automations` | object[] | `INVALID_AUTOMATION` — each item needs non-empty `event` and `prompt`; optional `room` as above. Only keys `event`, `prompt`, `room`. |

Anything else at top level or inside a nested object → `UNKNOWN_KEY`. Malformed YAML or bad native fields → OMP's `AgentParsingError`. `spawns` of the wrong type → `INVALID_TYPE`. Body missing or whitespace-only → `EMPTY_BODY`.

## Worked example

```markdown
---
name: reviewer
description: Reviews PRs and posts findings to #reviews.
model: "@review"
tools: [read, grep, chat_send, chat_read]   # parser appends "task"
spawns: [scout, implementor]
workspace: /home/user/work/acme             # absolute, no ~
rooms: ["#reviews"]
wake: { mention: true }
autonomy: { maxTurns: 40, budgetUsd: 2.50 }
sandbox: { enabled: true, extraRoots: ["/home/user/shared-assets"] }
skills: [omp-orchestration]
schedules:
  - cron: "0 9 * * 1-5"
    prompt: "Check for PRs opened overnight."
    room: "#reviews"
---
You are the code reviewer for this team. When woken with new messages…
```

## Creating one at runtime

Create, optionally update, then spawn — over the daemon socket, never one inline call:

1. **`agent_create`** — accepts only a **subset** of the definition: `{name, description, model, rooms, wake, autonomy, spawns, body}` — `name`/`description`/`body` are required non-empty strings; any other key (e.g. `skills`, `schedules`, `workspace`, `sandbox`, `tools`) is rejected at the socket. This is the validation checkpoint before anything is stored. Result: `{name, created: true}`.
2. **`definition_update`** — `{name, changes: {…}}` for every field `agent_create` does not take (`skills`, `schedules`, `automations`, `workspace`, `sandbox`, `mcps`, `tools`, …). Changes go through the same strict parser, so a bad key still throws before it lands.
3. **`agent_spawn`** — `{name, rooms?, cwd?, parent?}`. `parent` is spawn-time metadata (ADR-011): the spawner self-asserts it, it is never frontmatter, and it carries no authorization, budget, or room-ACL enforcement — but it IS load-bearing for lifecycle: kill cascades to children, and a child whose parent is gone is never woken. Omit it for a top-level peer.

Reading back: `definition_get` returns the stored definition.

## First-timer failure modes

- `UNKNOWN_KEY: "room"` — the key is `rooms` (plural), and it is an array.
- `INVALID_WORKSPACE` — `workspace: ~/project` or `workspace: ./project`. Must be absolute; expand `~` before writing.
- `INVALID_ROOM` — `rooms: [reviews]`. Entries need the `#`/`@` prefix.
- `INVALID_AUTONOMY` — `maxTurns: 40.5` (not an integer) or `budgetUsd: 0`.
- `MISSING_SPAWNS` — oh-my-agent requires `spawns:` even though native task agents do not. Use `spawns: "*"` to opt out of the allowlist.
- `EMPTY_BODY` — frontmatter with nothing after it. The body is the agent.
- `INVALID_SANDBOX` — `sandbox: seatbelt` is not a boolean or object; use `sandbox: true`.
- Nested-key typos throw too: `wake: { mentions: true }` → `UNKNOWN_KEY: "wake.mentions"`.
