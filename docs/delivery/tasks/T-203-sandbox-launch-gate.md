# T-203 — Sandbox launch gate

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-02](../epics/EP-02-worker-isolation.md) | [SP-02](../sprints/SP-02-isolation.md) | Done | [asset-map](../asset-map.md) |

## Goal

An opted-in peer launches sandboxed or does not launch.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Sandbox compiler](../../../src/worker/sandbox.ts)

## Files this task may change

- `src/worker/launch-gate.ts`
- `tests/sandbox-gate.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/launch-gate.ts`](../../../src/worker/launch-gate.ts) | New | Probe, then compile. |
| [`src/worker/sandbox.ts`](../../../src/worker/sandbox.ts) | Read | Supplies the compiler. |
| [`tests/sandbox-gate.test.ts`](../../../tests/sandbox-gate.test.ts) | New | 13 tests. |

## Steps

1. Probe the adapter binary and the gateway bridge before compiling anything.
2. Fail closed when either probe fails, rather than downgrading to an unconfined launch the user believes is sandboxed.
3. Return only the compiled command and argv.

## Acceptance

- [x] A missing adapter fails the launch.
- [x] An unreachable gateway bridge fails the launch.
- [x] A successful probe yields compiled argv.
- [x] 13 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Launch gate suite, 13 tests | [`tests/sandbox-gate.test.ts`](../../../tests/sandbox-gate.test.ts) |
| Commit | `19c2349` |

## Out of scope

- Nothing deferred.

## Depends on

- T-202

## Unblocks

- T-204
- T-401
