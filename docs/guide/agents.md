# Agents

A peer is one markdown file: YAML frontmatter plus a body. The body is standing instructions. The frontmatter is validated by a strict parser (`parsePeerDefinition`) that **throws on any key it does not know**. A typo is never ignored.

Create, then spawn. `agent create` does not start a worker. `spawn` does not take an inline definition.

Related: [Getting started](getting-started.md), [Concepts](concepts.md), skill [`omp-agent-authoring`](../../skills/omp-agent-authoring/SKILL.md).

## Where definitions live

| Root | Role |
|---|---|
| `~/.omp/agent/oh-my-agent/agents/*.md` | User store |
| `<daemon-project>/.omp/oh-my-agent/agents/*.md` | Project store. Shadows the user store. `agent create` writes here. |

`agent create` writes `<daemon-project>/.omp/oh-my-agent/agents/<name>.md`, where daemon-project is the cwd of `omp-agent daemon`, not the CLI cwd.

Neither path is an OMP discovery root. Putting a peer in `~/.omp/agent/agents/` would leak it into every unrelated OMP session. That root is for native task agents only. See [`omp-subagent-authoring`](../../skills/omp-subagent-authoring/SKILL.md).

You can also drop a `.md` file into either store by hand. The daemon re-reads the store; `agent create` is the supported write path because it refuses unknown keys before anything lands.

## Create vs edit

`omp-agent agent create <name> <file|->` accepts **only** this subset, taken from the document you authored, not from parser defaults:

| Key | Required |
|---|---|
| `name` | Yes, and it must match the command name |
| `description` | Yes |
| `body` | Yes, non-empty after the frontmatter |
| `model` | No at create, but spawn/materialize requires a fully qualified `provider/id` |
| `rooms` | No |
| `wake` | No |
| `autonomy` | No |
| `spawns` | Yes on the document. The parser requires it even though native task agents do not. |

Anything else in the frontmatter (`tools`, `workspace`, `sandbox`, `skills`, `schedules`, `mcps`, `automations`, …) is refused:

```
agent create cannot send tools; remove it and set it with `agent edit` once the peer exists
```

Set those fields with `omp-agent agent edit <name> <file|->`. The edit document is a **JSON object of changed fields**, not a re-rendered markdown file.

```sh
omp-agent agent create researcher researcher.md
echo '{"tools":["read","grep","chat_send","chat_read"]}' | omp-agent agent edit researcher -
omp-agent spawn researcher
```

`agent show <name>` prints the on-disk path, then the definition as JSON. `--json` prints the full protocol result `{ name, definition, filePath }`.

A successful edit prints `rebuild-required` or `live`. Policy changes (tools, sandbox, skills, model, …) rebuild the worker on the next delivery. Rooms-only membership changes are live.

## Frontmatter: native OMP keys

Validated by OMP's `parseAgent`. Unknown extras still fail in oh-my-agent's parser.

| Key | Type | Notes |
|---|---|---|
| `name` | string | Required. Peer identity. |
| `description` | string | Required. One line. |
| `model` | string | Fully qualified `provider/id`, e.g. `"anthropic/claude-sonnet-4-5"`. The provider is the account id and the credential-gateway route. `@role` aliases are **not** resolved for materialized peers. |
| `tools` | string[] | **Replaces** the default set. A restricted list gets `task` appended automatically so delegation survives. Set via `agent edit`, not `agent create`. |
| `spawns` | `"*"` \| string \| string[] | **Required**. In-run subagent allowlist. `"*"` = any. Missing → `MISSING_SPAWNS`. Empty → `EMPTY_SPAWNS`. |
| `thinking` / `thinkingLevel` | string | Reasoning effort override. |
| `output` | object | Structured-output schema for the final yield. |
| `blocking` | boolean | Whether dispatches to this agent block. |
| `autoloadSkills` | boolean | Load discovered skills into the system prompt. |
| `readSummarize` | object | Read-summarization behavior. |
| `prewalk` | object | Pre-run context walk. |
| `advisor` | object | Advisor model configuration. |

## Frontmatter: oh-my-agent keys

| Key | Type | Rejects with |
|---|---|---|
| `workspace` | absolute path string | `INVALID_WORKSPACE` - must be a string and `isAbsolute()`. `~/work` fails: expand it yourself. |
| `rooms` | string[] | `INVALID_ROOM` - array of strings, each starting with `#` (channel) or `@` (DM). |
| `wake` | object | `INVALID_WAKE` - only keys `mention` and `rooms`, both boolean. |
| `autonomy` | object | `INVALID_AUTONOMY` - only keys `maxTurns` (positive **integer**) and `budgetUsd` (positive **finite** number). |
| `sandbox` | boolean \| object | `INVALID_SANDBOX` - `true`/`false`, or `{ enabled, extraRoots }`. `extraRoots` entries must be absolute. |
| `mcps` | string[] | `INVALID_ARRAY` |
| `skills` | string[] | `INVALID_ARRAY` - names to materialize into the worker root, e.g. `omp-orchestration`. |
| `schedules` | object[] | `INVALID_SCHEDULE` - each item needs non-empty `cron` and `prompt`; optional `room` must start with `#`/`@`. Only keys `cron`, `prompt`, `room`. |
| `automations` | object[] | `INVALID_AUTOMATION` - each item needs non-empty `event` and `prompt`; optional `room` as above. Only keys `event`, `prompt`, `room`. |

Anything else at top level or inside a nested object → `UNKNOWN_KEY`. Malformed YAML or bad native fields → OMP's `AgentParsingError`. Wrong `spawns` type → `INVALID_TYPE`. Missing or whitespace-only body → `EMPTY_BODY`.

`parent` is not a frontmatter key. It is a spawn argument. Putting it in YAML throws `UNKNOWN_KEY`.

Schedule ids are runtime values, not authored fields. After spawn, `omp-agent schedule` lists ids of the form `<name>:schedule:<index>` and `<name>:automation:<index>`.

## Worked example

This is a full definition, including keys `agent create` will not take. Create the subset first, then `agent edit` the rest, or write the file into the project store after create.

```markdown
---
name: reviewer
description: Reviews PRs and posts findings to #reviews.
model: "anthropic/claude-sonnet-4-5"
tools: [read, grep, chat_send, chat_read]
spawns: [scout, implementor]
workspace: /home/user/work/acme
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

Shipped examples (git checkout only):

- [`agents/example-researcher.md`](../../agents/example-researcher.md) - create-subset, ready for `agent create`
- [`agents/example-reviewer.md`](../../agents/example-reviewer.md) - same

Both use `model: "anthropic/claude-sonnet-4-5"` and omit `tools:` so create succeeds. Add tools later with `agent edit`.

## Runtime sequence

Over the daemon socket, never one inline call:

1. **`agent create`** - subset only. Result: `{ name, created }`.
2. **`agent edit`** / `definition_update` - remaining fields. Same strict parser.
3. **`spawn`** / `agent_spawn` - `{ name, rooms?, cwd?, parent? }`. `parent` is spawn-time metadata. Omit it for a top-level peer.

From a running worker, `agent_spawn` also requires a non-empty `rooms` array. Check `omp-agent agents` before spawning a second copy of a live peer. To talk to an existing peer, post to a shared room. See [`omp-orchestration`](../../skills/omp-orchestration/SKILL.md).

## First-timer errors

Verified against the parser:

| You wrote | What happens |
|---|---|
| `room: "#reviews"` | `Unknown key: "room"` - the key is `rooms` (plural), and it is an array. |
| `workspace: ~/project` or `workspace: ./project` | `INVALID_WORKSPACE` - must be absolute; expand `~` yourself. |
| `rooms: [reviews]` | `INVALID_ROOM` - entries need `#` or `@`. |
| `autonomy: { maxTurns: 40.5 }` | `INVALID_AUTONOMY` - `maxTurns` must be a positive integer. `budgetUsd: 0` also fails. |
| No `spawns:` | `MISSING_SPAWNS` - required on peers. Use `spawns: "*"` to opt out of the allowlist. |
| Frontmatter only | `EMPTY_BODY` - the body is the agent. |
| `sandbox: seatbelt` | `INVALID_SANDBOX` - use `sandbox: true` or `{ enabled: true, extraRoots: [...] }`. |
| `wake: { mentions: true }` | `Unknown key: "wake.mentions"` - nested typos throw too. The key is `mention`. |
| `tools:` on `agent create` | CLI refuses: create cannot send `tools`. Use `agent edit`. |
| `model: "@task"` | Create may store it; spawn/materialize fails. Workers need `provider/id`. |
| `parent:` in YAML | `UNKNOWN_KEY`. Pass `--parent` to `spawn`. |

Next: [CLI](cli.md), [Rooms](rooms.md), [FAQ](faq.md).
