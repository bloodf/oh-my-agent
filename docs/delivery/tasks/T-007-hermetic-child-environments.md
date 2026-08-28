# T-007 — Hermetic child-process environments

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-00](../epics/EP-00-foundations-and-contracts.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

A test that spawns a child gets the environment it asked for, not the one the developer's shell happens to export.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Discovery contract](../../../tests/contracts/discovery.contract.test.ts)
- [Harness](../../../tests/harness.test.ts)

## Files this task may change

- `tests/fixtures/hermetic-env.ts`
- `tests/contracts/discovery.contract.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/fixtures/hermetic-env.ts`](../../../tests/fixtures/hermetic-env.ts) | New | `hermeticChildEnv`: scrubbed copy of `process.env` plus overrides. |
| [`tests/contracts/discovery.contract.test.ts`](../../../tests/contracts/discovery.contract.test.ts) | Edited | Spawns children through the fixture instead of spreading `process.env`. |
| [`tests/fixtures/temp-agent-dir.ts`](../../../tests/fixtures/temp-agent-dir.ts) | Read | Supplies the synthetic root the overrides point at. |

## Steps

1. Scrub every config-root selector OMP consults from the inherited environment: `PI_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and the profile variables.
2. Apply the caller's overrides last, so the synthetic `HOME`, `XDG_*`, and agent dir are the only values in play.
3. Route the discovery contract's child spawns through the fixture rather than spreading `process.env`, since that spread is exactly how a developer's exported `PI_CONFIG_DIR` silently reroutes a synthetic-home test into their real profile — the test then passes while asserting nothing.
4. Keep the scrub list in one place so a newly added selector is one edit, not a hunt through every suite that spawns a child.

## Acceptance

- [x] A child spawned through the fixture sees none of the host's config-root selectors.
- [x] With a poisoned `PI_CONFIG_DIR` exported, the discovery contract still resolves against the synthetic root.
- [x] The caller's overrides win over anything inherited.
- [x] 9 discovery-contract tests pass under a deliberately poisoned host environment.

Evidence:

| Claim | Anchor |
|---|---|
| Discovery contract, 9 tests | [`tests/contracts/discovery.contract.test.ts`](../../../tests/contracts/discovery.contract.test.ts) |

## Out of scope

- The production worker environment, which T-205 scrubs using the same canonical list.
- Credential and provider variables; this task is about config-root selectors only.

## Depends on

- T-002

## Unblocks

- Nothing.
