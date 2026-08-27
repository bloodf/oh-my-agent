# T-002 — Contract-test harness

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-00](../epics/EP-00-foundations-and-contracts.md) | [SP-01](../sprints/SP-01-contracts-and-parsing.md) | Done | [asset-map](../asset-map.md) |

## Goal

Suites can stand up a broker and a disposable agent directory without touching the user's real profile.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `tests/fixtures/fake-broker.ts`
- `tests/fixtures/temp-agent-dir.ts`
- `tests/harness.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/fixtures/fake-broker.ts`](../../../tests/fixtures/fake-broker.ts) | New | Loopback broker stand-in. |
| [`tests/fixtures/temp-agent-dir.ts`](../../../tests/fixtures/temp-agent-dir.ts) | New | Disposable `PI_CODING_AGENT_DIR`. |

## Steps

1. Write a fake broker binding `127.0.0.1:0`, since `startAuthBroker` otherwise defaults to port 8765.
2. Write a temp agent dir helper that cleans up on dispose.
3. Cover both fixtures with their own tests so a broken fixture fails loudly rather than silently weakening every suite.

## Acceptance

- [x] The fake broker binds an ephemeral loopback port.
- [x] The temp agent dir is removed after use.
- [x] 8 harness tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Harness suite, 8 tests | [`tests/harness.test.ts`](../../../tests/harness.test.ts) |
| Commit | `ff663c5` |

## Out of scope

- Nothing deferred.

## Depends on

- T-001

## Unblocks

- T-003
- T-004
- T-005
