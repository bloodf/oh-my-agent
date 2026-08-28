---
name: omp-orchestration
description: Choose the right delegation primitive — native task for temporary in-run subagents, agent_create + agent_spawn with parent for persistent children, agent_spawn alone for top-level peers, a room post to reach an existing peer.
---

# Orchestration: which primitive for which job

Four verbs, four meanings. Pick by **lifetime** first, then by **who initiates**.

## Decision table

| Situation | Primitive | Why |
|---|---|---|
| Bounded coding/research subtask inside your current run | native `task` dispatch | Temporary, transcript folds back, spawn-policy governed (ADR-007). |
| Standing up a durable teammate **under you** (a CTO standing up staff) | `agent_create` then `agent_spawn` with `parent` | Persistent child peer; survives restarts; kill cascades on your death (ADR-011). |
| Standing up a durable teammate with **no parent** | `agent_spawn` alone (after `agent_create`) | Top-level peer; independent lifecycle. |
| Talking to a peer that already exists | post to a room (`chat_send`) | Peers wake on `wake.mention` / `wake.rooms`; no spawn needed. |

## 1. Native `task` — temporary, in-run

```json
{ "tasks": [{ "agent": "scout", "task": "Locate the spawn-policy enforcement" }] }
```

Bounded to your run. Default when the subtask ends with this run. Format and policy: see `omp-subagent-authoring`.

## 2. Persistent child — `agent_create` + `agent_spawn` with `parent`

Two calls minimum, validation checkpoint in the middle. `agent_create` takes
only `{name, description, model, rooms, wake, autonomy, spawns, body}` — extra
fields (`skills`, `schedules`, `workspace`, …) go through `definition_update`:

```jsonc
// 1. Validate + store. A bad key throws HERE, not mid-spawn.
agent_create { "name": "staff-eng", "description": "…", "spawns": "*", "rooms": ["#ceo-team"], "body": "…" }
// 1b. Optional: attach fields create doesn't accept.
definition_update { "name": "staff-eng", "changes": { "skills": ["omp-orchestration"] } }

// 2. Start it under you. `parent` is YOUR name, self-asserted. `rooms`
//    is REQUIRED — the worker toolbelt rejects a spawn without a non-empty
//    rooms array (classifyAgentSpawn), even for a persistent child.
agent_spawn { "name": "staff-eng", "parent": "ceo", "rooms": ["#ceo-team"] }
```

What the child gets (ADR-011): your account, an auto-created family channel `#<parent>-team`, and nothing else — rooms and budget are NOT inherited. Parentage is spawn-time daemon state, never frontmatter: the same definition deploys under any parent, and no authorization, budget, or room-ACL enforcement is built on it. When you die, your children die with you (kill cascade); a child whose parent is gone is never woken.

## 3. Top-level peer — `agent_spawn` alone

```jsonc
agent_create { "name": "reviewer", "description": "…", "spawns": "*", "rooms": ["#reviews"], "body": "…" }
agent_spawn { "name": "reviewer", "rooms": ["#reviews"], "cwd": "/home/user/project" }
```

No `parent` → no cascade, no family channel. This is how the operator-facing agents start.

## 4. Reaching an existing peer — room post

```jsonc
chat_send { "room": "#reviews", "body": "@reviewer PR #412 is up" }
```

A peer joined to `#reviews` with `wake: { mention: true }` wakes on the `@mention`; `wake: { rooms: true }` wakes on any room traffic. Never spawn a second copy of a peer that is already running — check `agent_status` first.

## First-timer failure modes

- **`agent_spawn` without `rooms`** — the worker toolbelt rejects any spawn call lacking a non-empty `rooms` array, persistent child included (`classifyAgentSpawn`). And a coding subtask never belongs in `agent_spawn` at all — one-shot intent goes to `task`.
- **Skipping `agent_create`** — `agent_spawn` does not take an inline definition; the split exists so validation happens before anything runs.
- **Passing `skills:`/`schedules:` to `agent_create`** — rejected at the socket; create accepts only `{name, description, model, rooms, wake, autonomy, spawns, body}`. Set the rest with `definition_update`.
- **Parent in frontmatter** — rejected (`UNKNOWN_KEY`). Parentage is a spawn param, by design (ADR-011).
- **Assuming children inherit rooms/budget** — they inherit only the account and `#<parent>-team`. Join extra rooms explicitly at spawn (`rooms` param) or in the definition.
- **Spawning to talk** — if the peer exists and you want its attention, post to a shared room; spawn is for lifecycle, not messaging.
