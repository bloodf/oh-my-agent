# T-101 — Peer definition parser

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-01](../epics/EP-01-agent-definitions.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

A markdown file with YAML frontmatter becomes a validated `PeerDefinition` with a stable fingerprint.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Discovery contract](../../../tests/contracts/discovery.contract.test.ts)

## Files this task may change

- `src/shared/agent-definition.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | New | Parser, types, fingerprint. |
| [`tests/agent-definition.test.ts`](../../../tests/agent-definition.test.ts) | New | 59 tests. |

## Steps

1. Accept OMP's native task-agent keys unchanged so definitions stay portable.
2. Add plugin extras: `workspace`, `rooms`, `wake`, `autonomy`, `sandbox`, `mcps`, `skills`, `schedules`, `automations`.
3. Reject unknown keys at top level and inside nested objects, because a silently ignored typo in `sandbox:` is an unenforced policy.
4. Fingerprint the effective definition for staleness detection.

## Acceptance

- [x] Native and extra keys parse into `PeerDefinition`.
- [x] An unknown key raises `PeerParsingError` carrying a code.
- [x] `spawns:` accepts a list or `*`.
- [x] The fingerprint changes when any effective field changes.
- [x] 59 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Parser suite, 59 tests | [`tests/agent-definition.test.ts`](../../../tests/agent-definition.test.ts) |
| Commit | `d34fafa` |

## Out of scope

- Nothing deferred.

## Depends on

- T-003

## Unblocks

- T-201
- T-501
