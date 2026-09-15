# T-1803 — Remote policy gate and daemon hardening

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-18](../epics/EP-18-review-2026-09.md) | [SP-19](../sprints/SP-19-review-fixes.md) | Done | [asset-map](../asset-map.md) |

## Goal

Remote requests without full control can change only an agent's name, description, model, thinking level, and rooms. Profile saves, uploads, web chats, workspace inspection, setup reporting, directory listing, plan routes, and failed boots behave correctly under the edge cases the review found, and the TUI and CLI agree.

## Read first

- [The review findings D-01 to D-16](../../../docs/develop/review-2026-09.md)
- [Agent routes](../../../src/daemon/console-api.ts)

## Files this task may change

- `src/daemon/console-api.ts`
- `src/daemon/profile.ts`
- `src/daemon/web-attachments.ts`
- `src/daemon/web-chats.ts`
- `src/daemon/workspace-changes.ts`
- `src/daemon/web-files.ts`
- `src/daemon/web-routes.ts`
- `src/daemon/runtime.ts`
- `src/daemon/cli.ts`
- `src/extension/commands.ts`
- `src/extension/index.ts`
- `src/shared/setup-report.ts`
- `tests/daemon-cli.test.ts`
- `tests/daemon-runtime-composition.test.ts`
- `tests/extension.test.ts`
- `tests/profile.test.ts`
- `tests/setup-report.test.ts`
- `tests/web-attachments.test.ts`
- `tests/web-chats-lifecycle.test.ts`
- `tests/web-files.test.ts`
- `tests/web-workspace-security.test.ts`
- `tests/workspace-changes.test.ts`
- `docs/develop/modules.md`
- `docs/guide/cli.md`
- `docs/guide/console.md`
- `docs/web-console.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Allowlist of remote-editable agent fields; request body cap. |
| [`src/daemon/profile.ts`](../../../src/daemon/profile.ts) | Edited | Serialized updates with unique temp files. |
| [`src/daemon/web-attachments.ts`](../../../src/daemon/web-attachments.ts) | Edited | Per-file size cap and count limits with 413 and 429. |
| [`src/daemon/web-chats.ts`](../../../src/daemon/web-chats.ts) | Edited | Private storage directory, OMP in its own process group, files removed on close. |
| [`src/daemon/workspace-changes.ts`](../../../src/daemon/workspace-changes.ts) | Edited | Submodule filters ignored, non-UTF-8 names tolerated, status truncation. |
| [`src/daemon/web-files.ts`](../../../src/daemon/web-files.ts) | Edited | Sort before capping and report truncation. |
| [`src/daemon/web-routes.ts`](../../../src/daemon/web-routes.ts) | Edited | Method checked before the body. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | Console URL ordering; workers stopped when a later boot step fails. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | Unknown leading flags are errors. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | /logs daemon, /kill keep-children, /preset argument order, /edit. |
| [`src/extension/index.ts`](../../../src/extension/index.ts) | Edited | Registers /edit. |
| [`src/shared/setup-report.ts`](../../../src/shared/setup-report.ts) | Edited | Parked crew and drift direction. |
| [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) | Edited | Unknown flag test. |
| [`tests/daemon-runtime-composition.test.ts`](../../../tests/daemon-runtime-composition.test.ts) | New | Boot unwind, invalid console port, shutdown during spawn, and wired web routes through bootDaemon. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | TUI command alignment tests. |
| [`tests/profile.test.ts`](../../../tests/profile.test.ts) | Edited | Concurrent update test. |
| [`tests/setup-report.test.ts`](../../../tests/setup-report.test.ts) | New | Parked crew and drift direction. |
| [`tests/web-attachments.test.ts`](../../../tests/web-attachments.test.ts) | Edited | Size and count limit tests. |
| [`tests/web-chats-lifecycle.test.ts`](../../../tests/web-chats-lifecycle.test.ts) | New | Storage directory, process group, and close cleanup with a stand-in CLI. |
| [`tests/web-files.test.ts`](../../../tests/web-files.test.ts) | New | Listing order, cap, and attachmentReferences. |
| [`tests/web-workspace-security.test.ts`](../../../tests/web-workspace-security.test.ts) | Edited | Remote policy field gate tests. |
| [`tests/workspace-changes.test.ts`](../../../tests/workspace-changes.test.ts) | Edited | Submodule filter, non-UTF-8 name, and truncation tests. |
| [`docs/develop/modules.md`](../../../docs/develop/modules.md) | Edited | Every source module and test suite. |
| [`docs/guide/cli.md`](../../../docs/guide/cli.md) | Edited | models verb and TUI counterparts. |
| [`docs/guide/console.md`](../../../docs/guide/console.md) | Edited | What remote operators may edit without full control. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | Agent route gate and upload limits. |

## Steps

1. Gate policy-bearing agent fields behind remote full control with an allowlist.
2. Fix each daemon edge case with a test that fails without the fix.
3. Align the TUI with the CLI and refresh the module map.

## Acceptance

- [x] A remote request without full control that changes sandbox, tools, or body gets 403 and writes nothing.
- [x] Concurrent profile saves keep both edits; oversized uploads get 413.
- [x] A failed boot stops workers it already started.

Evidence:

| Claim | Anchor |
|---|---|
| Remote policy gate tests | [`tests/web-workspace-security.test.ts`](../../../tests/web-workspace-security.test.ts) |
| Composition-root tests | [`tests/daemon-runtime-composition.test.ts`](../../../tests/daemon-runtime-composition.test.ts) |

## Out of scope

- Inference gateway lifecycle, stop mid-boot, usage single-flight, and the attachment cleanup timer need a real OMP session or long timers and stay untested through bootDaemon.

## Depends on

- Nothing.

## Unblocks

- Nothing.
