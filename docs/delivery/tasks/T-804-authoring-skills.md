# T-804 — Shipped skills for agent and subagent authoring

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-08](../epics/EP-08-agent-hierarchy.md) | [SP-09](../sprints/SP-09-agent-hierarchy.md) | Ready | [asset-map](../asset-map.md) |

## Goal

Creating an agent or subagent is a guided skill, not a search through the codebase.

## Read first

- [Skill discovery in OMP](../../../node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/skills.ts)
- [Materializer skill wiring](../../../src/daemon/materializer.ts)
- [ADR-011: agent hierarchy](../../../docs/delivery/adr/ADR-011-agent-hierarchy.md)

## Files this task may change

- `skills/omp-agent-authoring/SKILL.md`
- `skills/omp-subagent-authoring/SKILL.md`
- `skills/omp-orchestration/SKILL.md`
- `tests/skills.test.ts`
- `package.json`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `skills/omp-agent-authoring/SKILL.md` (to be created) | New | Authoring a peer definition: format, rooms, wake, autonomy, sandbox, spawns — with the strict parser's error codes. |
| `skills/omp-subagent-authoring/SKILL.md` (to be created) | New | Authoring native `task` subagents: when temporary is right, spawns policy, output contract. |
| `skills/omp-orchestration/SKILL.md` (to be created) | New | The selection guide: task vs child peer vs top-level peer vs room message. |
| `tests/skills.test.ts` (to be created) | New | OMP's real `loadSkills` discovers all three from the package root; frontmatter parses with required fields. |
| [`package.json`](../../../package.json) | Edited | Ships `skills/` in `files` if the manifest does not already cover them. |

## Steps

1. Write the three skills in OMP's SKILL.md format (`name` + `description` required), each with the exact frontmatter shape, a worked example, and the failure modes a first-timer hits.
2. Prove discovery with OMP's real `loadSkills`/`discoverSkills` against the package root, so an OMP upgrade that breaks the plugins provider fails our suite, not the user.
3. Wire the materializer: a peer definition's `skills:` key selects these by name and they land in the worker root (the mechanism exists; prove it with a materialization test).

## Acceptance

- [ ] All three skills are discovered by OMP's real loader from the installed package layout.
- [ ] Each skill's frontmatter parses and carries the required fields.
- [ ] A worker whose definition selects a skill receives it in the materialized root.

## Out of scope

- Auto-learning skills from sessions (OMP's managed-skills feature is not ours to drive).

## Depends on

- T-501

## Unblocks

- Nothing.
