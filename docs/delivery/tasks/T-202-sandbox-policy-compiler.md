# T-202 — Typed sandbox policy compiler

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-02](../epics/EP-02-worker-isolation.md) | [SP-02](../sprints/SP-02-isolation.md) | Done | [asset-map](../asset-map.md) |

## Goal

One typed policy compiles to a macOS Seatbelt profile or Linux `bwrap` argv.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)

## Files this task may change

- `src/worker/sandbox.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/sandbox.ts`](../../../src/worker/sandbox.ts) | New | Policy type and both compilers. |
| [`tests/sandbox.test.ts`](../../../tests/sandbox.test.ts) | New | 51 tests. |

## Steps

1. Define the policy: workspace, worker home, runtime paths, gateway endpoint, loopback ports, extra roots.
2. Compile Darwin to `-p <profile>` with no `--` separator, and Linux to `bwrap` argv which does take one.
3. Fail closed on Linux unless the peer accepts `unrestricted-host-network`, because `--share-net` cannot enforce port-level loopback.

## Acceptance

- [x] Darwin profiles allow the declared roots and the loopback gateway port.
- [x] Linux argv is rejected without explicit network acceptance.
- [x] An unsupported platform fails closed.
- [x] 51 tests pass.

Evidence:

| Claim | Anchor |
|---|---|
| Sandbox suite, 51 tests | [`tests/sandbox.test.ts`](../../../tests/sandbox.test.ts) |
| Commit | `84ff8d9` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-203
