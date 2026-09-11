# T-1622 — A preset library and the first mate orchestrator

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Ten role definitions ship with the package but are never seeded, reachable from every surface as a starting point for a new peer, and a seeded first mate is the one peer the operator talks to: it picks the task shape, dispatches to the staff, hires from the presets, supervises through the rooms, and reports outcomes.

## Read first

- [How the staff are seeded once](../../../src/daemon/default-peers.ts)
- [What agent_create accepts](../../../src/shared/protocol.ts)
- [The worker toolbelt's delegation guidance](../../../src/worker/toolbelt.ts)

## Files this task may change

- `src/defaults/agents/mate.md`
- `src/defaults/presets/researcher.md`
- `src/defaults/presets/reviewer.md`
- `src/defaults/presets/security-reviewer.md`
- `src/defaults/presets/tech-writer.md`
- `src/defaults/presets/sre.md`
- `src/defaults/presets/debugger.md`
- `src/defaults/presets/test-engineer.md`
- `src/defaults/presets/designer.md`
- `src/defaults/presets/release-manager.md`
- `src/defaults/presets/data-analyst.md`
- `src/daemon/presets.ts`
- `src/daemon/runtime.ts`
- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `src/daemon/cli.ts`
- `src/daemon/console-api.ts`
- `src/extension/commands.ts`
- `src/worker/toolbelt.ts`
- `web/src/console/CreateAgentDialog.tsx`
- `tests/default-peers.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/defaults/agents/mate.md`](../../../src/defaults/agents/mate.md) | New | The first mate: single point of contact, ship or scout, dispatch, supervise, escalate only real decisions, report in #bridge. |
| [`src/defaults/presets/researcher.md`](../../../src/defaults/presets/researcher.md) | New | Investigates against primary sources and leaves a report with evidence. |
| [`src/defaults/presets/reviewer.md`](../../../src/defaults/presets/reviewer.md) | New | Reviews diffs for defects and missing tests; one line per finding. |
| [`src/defaults/presets/security-reviewer.md`](../../../src/defaults/presets/security-reviewer.md) | New | Audits trust boundaries and secrets; ranks findings by exploitability. |
| [`src/defaults/presets/tech-writer.md`](../../../src/defaults/presets/tech-writer.md) | New | User-facing docs and changelog that the code does not contradict. |
| [`src/defaults/presets/sre.md`](../../../src/defaults/presets/sre.md) | New | Builds, deploys, CI, incidents; every change reversible. |
| [`src/defaults/presets/debugger.md`](../../../src/defaults/presets/debugger.md) | New | Root cause by reproduction and bisection, with the failing test. |
| [`src/defaults/presets/test-engineer.md`](../../../src/defaults/presets/test-engineer.md) | New | Tests that fail when the code is wrong; flaky ones hardened. |
| [`src/defaults/presets/designer.md`](../../../src/defaults/presets/designer.md) | New | Interfaces and flows specified to build, with every state and accessibility. |
| [`src/defaults/presets/release-manager.md`](../../../src/defaults/presets/release-manager.md) | New | Cuts releases against the gates and the changelog; never force-pushes. |
| [`src/defaults/presets/data-analyst.md`](../../../src/defaults/presets/data-analyst.md) | New | Numbers with their query and their caveats. |
| [`src/daemon/presets.ts`](../../../src/daemon/presets.ts) | New | Reads the library through the strict parser; a preset is named by its file. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | listPresets wired into the socket and console contexts. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | presets_list and PresetInfo, additive. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | presets_list validators; each preset validated as a create payload. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | presets_list handler, worker-callable. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | omp-agent presets and agent create <name> --preset <preset>. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | GET /api/presets. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | /preset: pick and name, or both up front; never spawns. |
| [`src/worker/toolbelt.ts`](../../../src/worker/toolbelt.ts) | Edited | A presets_list tool and hiring guidance. |
| [`web/src/console/CreateAgentDialog.tsx`](../../../web/src/console/CreateAgentDialog.tsx) | Edited | A Start from a preset picker that fills the form. |
| [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) | Edited | Every preset parses and is a create payload; none is seeded; the mate's brief names the hiring calls. |

## Steps

1. Write the presets and the mate as ordinary definitions with spawns: "*" and no model.
2. Read the library through parsePeerDefinition and refuse a preset whose name disagrees with its file.
3. Expose it as presets_list and copy a preset's fields unchanged apart from the name from the TUI, the CLI, the console, and the toolbelt.

## Acceptance

- [x] presets_list answers ten presets over the real socket, each accepted by agent_create under a new name.
- [x] Seeding an empty store writes the staff and the mate and nothing from the presets.
- [x] Each surface creates from a preset without spawning and refuses an unknown preset by name.

Evidence:

| Claim | Anchor |
|---|---|
| Presets parse, are create payloads, and are never seeded; the mate's brief | [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) |
| presets_list over the real socket and creation from a preset | [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) |
| omp-agent presets and agent create --preset | [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) |
| /preset from the picker and with both arguments | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |
| GET /api/presets with and without a library | [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) |

## Out of scope

- Driving the mate through a real request on a live daemon: its brief is tested for shape, not behavior.

## Depends on

- T-1620

## Unblocks

- Nothing.
