# T-1306 — Consumer-install smoke test

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-13](../epics/EP-13-distribution.md) | [SP-14](../sprints/SP-14-release-pipeline.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

Prove the packed artifact works for a real consumer: npm pack, install the tarball into a temp project with fresh peer resolution from the registry (npm and bun variants), invoke the installed node_modules/.bin/omp-agent shim — never the source path — boot the daemon through it, and assert the RpcClient.pid contract state per amended ADR-013. This is the test that makes the patch-travel gap visible before a user hits it.

## Read first

- [ADR-013: release channel](../../../docs/delivery/adr/ADR-013-release-channel.md)
- [Package manifest](../../../package.json)
- [The pack test this extends](../../../docs/delivery/tasks/T-1301-packable-artifact.md)

## Files this task may change

- `tests/consumer-install.test.ts`
- `package.json`
- `.github/workflows/ci.yml`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `tests/consumer-install.test.ts` (to be created) | New | Packs, installs into a temp project with fresh peer resolution, drives the installed shim, boots the daemon, records the pid contract state. |
| [`package.json`](../../../package.json) | Edited | A script entry wrapping the smoke test; the bin mapping itself is unchanged. |
| [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | Edited | Runs the consumer-install smoke test on changes to package.json, patches/, or src/. |

## Steps

1. npm pack, then install the tarball into a temp project with fresh peer resolution from the registry — both the npm and bun install variants.
2. Invoke the installed node_modules/.bin/omp-agent shim, never the source path; assert the exit code and boot the daemon through it.
3. Assert the RpcClient.pid contract state of the resolved peer per amended ADR-013: 'pid absent, degraded supervision' until T-1504 lands, 'pid present' after — the same test enforces both states, so the gap shows up here before a user hits it.
4. Wire the run into CI on every change to package.json, patches/, or src/.

## Acceptance

- [ ] The smoke test invokes the installed shim, asserts exit code and daemon boot, and records the pid contract state.
- [ ] CI runs it on every change to package.json, patches/, or src/.

## Out of scope

- Nothing deferred.

## Depends on

- T-1301

## Unblocks

- T-1303
- T-1304
