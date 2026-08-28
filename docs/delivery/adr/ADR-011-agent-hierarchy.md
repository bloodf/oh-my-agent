# ADR-011 — Persistent child agents are spawn-time state; kill cascades

**Status:** Accepted

## Context

A peer must be able to deploy persistent child peers (a CEO standing up a CTO, staff engineers, QA) that live under it in a tree, survive restarts, and stay distinct from native `task` subagents, which are temporary and in-run. The design had to answer where parentage lives, how the daemon learns the spawner's identity over an unauthenticated shared socket, whether spawn carries an inline definition, what children inherit, and what happens to children when a parent dies.

## Decision

Parentage is daemon spawn-time state (an `agents.parent` column), never frontmatter — the same definition deploys under different parents and the strict parser stays untouched. The spawning worker self-asserts its name in `agent_spawn`'s optional `parent` param; the socket trusts every caller equally today, so parentage is cooperative metadata and nothing (budget, kill authority, room ACLs) may ever be enforced off it until real connection identity exists. Creation is two calls: `agent_create` writes a parse-validated definition to the peer store, then `agent_spawn` starts it — an LLM caller gets a validation checkpoint before anything runs. Children inherit only the parent's account and an auto-created family channel `#<parent>-team`; rooms and budget are explicit, because a shared budget lets one runaway child starve its siblings invisibly. `kill` cascades to the subtree by default (with an explicit keep-children reparent), and at boot an agent whose parent is gone is refused and flagged orphaned rather than silently resumed.

## Consequences

- The frozen protocol grows additively under the no-bump policy: agent_create, definition_get, definition_update, a parent field on spawn, and parent/children on status.
- A misbehaving peer can claim any parent — documented as cosmetic metadata, so no enforcement may ever be built on it without a connection-identity task first.
- Orphanhood is an impossible steady state: cascades and the boot refusal remove the cleanup chore.
- Native `task` remains the only temporary-subagent path; hierarchy never competes with it (ADR-007 stands).

## Alternatives considered

| Option | Why rejected |
|---|---|
| Parent in the definition frontmatter | Freezes topology at parse, breaks definition portability across installs, and forces the strict parser to grow a runtime-only key. |
| Inline definition in agent_spawn params | An LLM caller would emit full frontmatter inside JSON; the strict parser turns every hallucinated key into a mid-spawn throw with no validation checkpoint. |
| Children inherit rooms and budget | Room inheritance leaks operator-facing channels to every child; budget inheritance lets one runaway child starve siblings without a trace. |
| Orphan cleanup sweep | A sweeper runs after the failure; refusing the wake and cascading kills make the state impossible instead. |

## Evidence

| Claim | Source |
|---|---|
| Hierarchy design in the tree | [`docs/delivery/tasks/T-802-daemon-hierarchy.md`](../../../docs/delivery/tasks/T-802-daemon-hierarchy.md) |
