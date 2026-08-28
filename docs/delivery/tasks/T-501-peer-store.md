# T-501 — Peer store: load definitions from the private paths

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-05](../epics/EP-05-operator-surface.md) | [SP-05](../sprints/SP-05-operator-surface.md) | Ready | [asset-map](../asset-map.md) |

## Goal

The daemon can enumerate peer definitions from the user and project private stores.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Parser](../../../src/shared/agent-definition.ts)
- [Discovery contract](../../../tests/contracts/discovery.contract.test.ts)

## Files this task may change

- `src/daemon/peer-store.ts`
- `tests/peer-store.test.ts`
- `agents/example-researcher.md`
- `agents/example-reviewer.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/daemon/peer-store.ts` (to be created) | New | Enumerates and parses definitions. |
| `tests/peer-store.test.ts` (to be created) | New | Shadowing, malformed files, empty store. |
| `agents/example-researcher.md` (to be created) | New | Shipped example definition; §8 promises this directory exists. |
| `agents/example-reviewer.md` (to be created) | New | Second example, showing `spawns:` and room subscriptions. |
| [`src/shared/agent-definition.ts`](../../../src/shared/agent-definition.ts) | Read | `parsePeerDefinition` already exists; do not reimplement parsing. |
| [`src/daemon/materializer.ts`](../../../src/daemon/materializer.ts) | Read only, not edited by this task | Consumes the loaded definitions. |

## Steps

1. Read `~/.omp/agent/oh-my-agent/agents/*.md` and `<project>/.omp/oh-my-agent/agents/*.md`.
2. Let a project definition shadow a user definition of the same name, matching OMP's own precedence so users are not surprised.
3. Parse each through `parsePeerDefinition`; surface a parse failure with its file path rather than skipping the file silently, since a silently skipped peer looks identical to a peer that never existed.
4. Treat a missing or empty store directory as an empty listing. A first run has no store, and a daemon that cannot boot until the user has written an agent is a daemon nobody gets to try.
5. Ship two example definitions under `agents/`, which the architecture's repo layout already promises: a parser with no example is a schema users reverse-engineer from source.
6. Expose lookup by name plus a full listing for `/agents`.

## Acceptance

- [ ] Definitions load from both stores, with project shadowing user.
- [ ] Neither path is an OMP discovery root, re-asserted here so a future refactor cannot quietly relocate the store into one.
- [ ] A malformed definition reports its file path and does not abort the whole listing.
- [ ] A missing or empty store directory yields an empty listing, not an error.
- [ ] Both shipped examples parse through `parsePeerDefinition` in the suite, so a schema change cannot leave the documentation lying.
- [ ] Lookup by name returns the shadowing definition.

## Out of scope

- Materialization, which T-201 already owns.

## Depends on

- T-101

## Unblocks

- T-502
- T-505
- T-605
