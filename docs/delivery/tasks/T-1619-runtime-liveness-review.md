# T-1619 — A live daemon, its peers, and its console behave as they report

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Every defect found by driving a real install end to end is fixed at its root, with a regression test that fails without the fix: a live daemon is never reported absent, peers stay in the state the operator put them, long schedules do not loop, sandboxed and consumer-installed workers run, and the console reads rooms without scanning their full history.

## Read first

- [Extension client and session start](../../../src/extension/widget.ts)
- [Daemon composition and shutdown](../../../src/daemon/runtime.ts)
- [Worker launch and pid](../../../src/worker/lifecycle.ts)

## Files this task may change

- `src/shared/version.ts`
- `src/extension/widget.ts`
- `src/extension/ensure-daemon.ts`
- `src/daemon/runtime.ts`
- `src/daemon/scheduler.ts`
- `src/daemon/supervisor.ts`
- `src/worker/lifecycle.ts`
- `src/daemon/web-chats.ts`
- `src/daemon/console-api.ts`
- `src/rooms/store.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/version.ts`](../../../src/shared/version.ts) | New | The package version as one value; status reports it so a daemon older than its plugin says so. |
| [`src/extension/widget.ts`](../../../src/extension/widget.ts) | Edited | A token fault is DaemonAuthError, never absence; the unread count follows a real cursor instead of re-reading every room. |
| [`src/extension/ensure-daemon.ts`](../../../src/extension/ensure-daemon.ts) | Edited | Spawns only on absence, bounds the wait, and surfaces the launcher's own reason. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | AlreadyRunningError answers a second launch cleanly; credential files heal; every shutdown step runs; start failures reach status. |
| [`src/daemon/scheduler.ts`](../../../src/daemon/scheduler.ts) | Edited | Delays past the timer bound are chained, and impossible dates are refused before the scan. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | A stopped peer is never rebuilt into a running one; a killed peer is unregistered from its account. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | Sandbox read roots come from the executed artifacts; the launch shim records the worker pid for unpatched installs. |
| [`src/daemon/web-chats.ts`](../../../src/daemon/web-chats.ts) | Edited | Chat liveness comes from a shim-recorded pid, so chats work without the repository's patch. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Point reads replace full-history scans; loopback pages are uncached and refuse foreign WebSocket origins. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Edited | latestMessageId and getMessage; pre-threading databases gain parent_id. |

## Steps

1. Reproduce each defect from a real install's logs or a real code path, not from the suite, which passed throughout.
2. Fix each at the shared function every caller routes through rather than at the one caller that surfaced it.
3. Add a regression test per fix that drives production code, then revert the fixing line and confirm that exact test fails before restoring it.

## Acceptance

- [x] A missing operator token against a live socket is reported as an auth fault and never triggers a spawn; a second launch against a live daemon exits zero and names it.
- [x] A killed peer stays stopped after its definition changes, and a cron more than 24.8 days out is armed once rather than in a loop.
- [x] A worker on an install without the patch reports its pid, and a web chat there is reported running.
- [x] A console post lands in a room with more history than any fixed read-back window, and a loopback WebSocket upgrade from a foreign origin is refused.

Evidence:

| Claim | Anchor |
|---|---|
| Token fault is not absence; ensureDaemon does not spawn on it | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |
| Second launch against a live daemon exits zero without a stack | [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) |
| Token heals, status carries the version, shutdown survives a failing step | [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) |
| Killed peer is not rebuilt by a stale definition | [`tests/supervisor.test.ts`](../../../tests/supervisor.test.ts) |
| Long delays chain; impossible dates are refused quickly | [`tests/scheduler.test.ts`](../../../tests/scheduler.test.ts) |
| Shim-recorded worker pid; Linux sandbox acceptance | [`tests/worker-lifecycle.test.ts`](../../../tests/worker-lifecycle.test.ts) |
| Web chat liveness without the patched accessor | [`tests/web-workspace-security.test.ts`](../../../tests/web-workspace-security.test.ts) |
| Long-history post and foreign-origin WebSocket refusal | [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) |
| Commit | `c5c78ed` |
| Commit | `aba7dd4` |
| Commit | `00225ce` |
| Commit | `7d88b66` |
| Commit | `622c6b4` |
| Commit | `7fc9f8e` |

## Out of scope

- Raising the OMP floor and removing the RpcClient.pid patch (T-1504), whose acceptance waits on a released upstream accessor.
- Returning from inject before a running peer's turn completes, which would change the documented meaning of queued.

## Depends on

- Nothing.

## Unblocks

- Nothing.
