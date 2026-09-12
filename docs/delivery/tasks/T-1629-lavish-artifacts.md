# T-1629 — Lavish Editor for reviewable HTML artifacts

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

A peer can hand the operator a plan, comparison, or report as a page: it writes HTML, opens it with Lavish Editor headless, and polls for feedback; the operator finds every such session in the console's Artifacts view and opens the review from there. On the way, definitions that select skills start at all: the runtime now hands the materializer the package's skill roots.

## Read first

- [The materializer's skill and env handling](../../../src/daemon/materializer.ts)
- [The console API's options and routes](../../../src/daemon/console-api.ts)
- [The upstream skill this stub mirrors](../../../skills/lavish/SKILL.md)

## Files this task may change

- `src/daemon/skill-roots.ts`
- `src/daemon/artifacts.ts`
- `src/daemon/runtime.ts`
- `src/daemon/materializer.ts`
- `src/daemon/console-api.ts`
- `skills/lavish/SKILL.md`
- `src/defaults/agents/mate.md`
- `src/defaults/agents/staff-pm.md`
- `src/defaults/agents/staff-backend.md`
- `src/defaults/agents/staff-frontend.md`
- `src/defaults/agents/staff-qa.md`
- `web/src/console/ArtifactsView.tsx`
- `web/src/console/ConsoleShell.tsx`
- `web/src/console/Storybook.tsx`
- `storybook/console/stories.js`
- `src/console/app.js`
- `src/console/style.css`
- `tests/console-api.test.ts`
- `tests/materializer.test.ts`
- `tests/skills.test.ts`
- `tests/default-peers.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/skill-roots.ts`](../../../src/daemon/skill-roots.ts) | New | The package's skills directory as name to root; the map the materializer was never given. |
| [`src/daemon/artifacts.ts`](../../../src/daemon/artifacts.ts) | New | Lavish sessions from its state.json, and a bounded resume through npx or bunx. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | Hands packageSkillRoots to every materialization. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Edited | Workers get LAVISH_AXI_NO_OPEN and the operator's LAVISH_AXI_STATE_DIR. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | GET and POST /api/artifacts. |
| [`skills/lavish/SKILL.md`](../../../skills/lavish/SKILL.md) | New | A stub that sends the agent to the lavish-axi CLI for current guidance, plus how it fits this daemon. |
| [`src/defaults/agents/mate.md`](../../../src/defaults/agents/mate.md) | Edited | Reach for an artifact when the operator should see rather than read; skills: lavish. |
| [`src/defaults/agents/staff-pm.md`](../../../src/defaults/agents/staff-pm.md) | Edited | skills: lavish. |
| [`src/defaults/agents/staff-backend.md`](../../../src/defaults/agents/staff-backend.md) | Edited | skills: lavish. |
| [`src/defaults/agents/staff-frontend.md`](../../../src/defaults/agents/staff-frontend.md) | Edited | skills: lavish. |
| [`src/defaults/agents/staff-qa.md`](../../../src/defaults/agents/staff-qa.md) | Edited | skills: lavish. |
| [`web/src/console/ArtifactsView.tsx`](../../../web/src/console/ArtifactsView.tsx) | New | The Artifacts view: sessions with status and queued prompts, Open review resumes and opens. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | An Artifacts tab. |
| [`web/src/console/Storybook.tsx`](../../../web/src/console/Storybook.tsx) | Edited | Fixtures and a story for the view. |
| [`storybook/console/stories.js`](../../../storybook/console/stories.js) | Edited | The page-artifacts story. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Rebuilt. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Rebuilt. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Listing from a fixture state file; resume of a known session; refusals. |
| [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) | Edited | The worker env runs Lavish headless in the operator's state dir. |
| [`tests/skills.test.ts`](../../../tests/skills.test.ts) | Edited | The lavish skill is packaged. |
| [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) | Edited | The crew and every preset declare it. |

## Steps

1. Ship a stub skill that defers to the CLI, as upstream does, so it cannot go stale, and declare it on every default peer and preset.
2. Give the materializer the package's skill roots, and give workers a headless Lavish pointed at the operator's state dir.
3. List sessions from Lavish's own state and resume one on request; never open a file Lavish does not already hold.

## Acceptance

- [x] A definition with skills: [lavish] materializes with the skill under its agent dir.
- [x] The Artifacts view lists sessions newest first and Open review resumes the chosen one.
- [x] A worker's env carries LAVISH_AXI_NO_OPEN=1 and a state dir outside its synthetic HOME.

Evidence:

| Claim | Anchor |
|---|---|
| Artifact routes over a fixture state file | [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) |
| Worker env for Lavish | [`tests/materializer.test.ts`](../../../tests/materializer.test.ts) |
| The skill is packaged and loads | [`tests/skills.test.ts`](../../../tests/skills.test.ts) |
| Crew and presets declare it | [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) |

## Out of scope

- Bundling lavish-axi as a dependency: the package ships no runtime dependencies, and Lavish is an AXI meant to run through npx on demand.

## Depends on

- T-1628

## Unblocks

- T-1630
