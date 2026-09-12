# T-1625 — A setup checklist for operators and the OMP assistant

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

An operator runs one command and sees what a working install still needs, with the fix on every failing line; the TUI applies the two fixes it can, and a shipped skill lets the OMP assistant walk the operator through the same lines.

## Read first

- [The catalog and the default, with routability](../../../src/daemon/inference-gateway.ts)
- [Start failures on status](../../../src/daemon/socket.ts)
- [How OMP finds a plugin's skills](../../../skills/omp-orchestration/SKILL.md)

## Files this task may change

- `src/shared/setup-report.ts`
- `src/extension/setup.ts`
- `src/extension/commands.ts`
- `src/extension/index.ts`
- `src/daemon/cli.ts`
- `src/daemon/startup.ts`
- `skills/oh-my-agent-setup/SKILL.md`
- `tests/extension.test.ts`
- `tests/daemon-cli.test.ts`
- `tests/skills.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/setup-report.ts`](../../../src/shared/setup-report.ts) | New | The checklist over a call function: daemon, models, default, crew, rooms; ✓/✗ lines with the fix. |
| [`src/extension/setup.ts`](../../../src/extension/setup.ts) | New | /setup: the checklist, then a model picker for the crew and a start for stopped peers. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | guard is exported for the setup command. |
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | /setup registered. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | omp-agent setup prints the same checklist. |
| [`src/daemon/startup.ts`](../../../src/daemon/startup.ts) | Edited | Usage line. |
| [`skills/oh-my-agent-setup/SKILL.md`](../../../skills/oh-my-agent-setup/SKILL.md) | New | What each ✗ line means and the fix, a smoke request in #bridge, and what not to do. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | Daemon down; a ready install; the model pick and the crew start. |
| [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) | Edited | The checklist in text and JSON. |
| [`tests/skills.test.ts`](../../../tests/skills.test.ts) | Edited | The setup skill is packaged and loads. |

## Steps

1. Collect the checklist over the existing methods only: status, models_list, rooms_list.
2. Offer a fix only when its precondition holds, and write a model only to crew peers still on the default.
3. Write the skill against the checklist's own lines so the assistant and the command never disagree.

## Acceptance

- [x] A down daemon yields one ✗ line with the restart command and no prompts.
- [x] A complete install yields only ✓ lines ending with the mate's address.
- [x] An unroutable default offers the catalog and writes the pick to the crew peers on the default; stopped crew are offered a start and spawned on confirmation.

Evidence:

| Claim | Anchor |
|---|---|
| Daemon down, ready install, model pick, crew start | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |
| omp-agent setup in text and JSON | [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) |
| The skill is packaged | [`tests/skills.test.ts`](../../../tests/skills.test.ts) |

## Out of scope

- Writing models.yml for the operator: a provider entry needs credentials the daemon must not handle from a prompt.

## Depends on

- T-1624

## Unblocks

- T-1626
