# T-1103 — CLI management verbs: no TUI required

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-11](../epics/EP-11-operator-polish.md) | [SP-12](../sprints/SP-12-operator-polish.md) | Ready | [asset-map](../asset-map.md) |

## Goal

Every daemon operation runs from a shell: `omp-agent <verb>` talks to the daemon socket and exits usefully, with no OMP session at all.

## Read first

- [Daemon entry and CLI dispatch](../../../src/daemon/main.ts)
- [Protocol](../../../src/shared/protocol.ts)
- [Socket client patterns](../../../src/extension/widget.ts)

## Files this task may change

- `src/daemon/cli.ts`
- `src/daemon/main.ts`
- `tests/daemon-cli.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/daemon/cli.ts` (to be created) | New | The verb handlers and the socket client; pure functions per verb so the suite can drive them directly. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | Dispatches verbs to the CLI handlers; `daemon` stays the default. |
| `tests/daemon-cli.test.ts` (to be created) | New | Every verb against a real booted daemon; daemon-down errors; exit codes; --json shape. |

## Steps

1. Verbs: `status`, `agents`, `spawn <name> [--parent <p>]`, `kill <name> [--keep-children]`, `rooms`, `rooms read <room>`, `rooms post <room> <text>`, `schedule`, `schedule <id> on|off`, `logs <name> [n]`, `inject <name> <text>`, `bump <account> <usd>`, `console` (prints the console URL).
2. Resolve the socket from the active agent dir exactly as the TUI does; a down daemon exits 3 with 'daemon not running' on stderr, never a stack trace.
3. Exit codes: 0 ok, 2 usage, 3 daemon down, 4 daemon-side error. `--json` emits the protocol result verbatim for scripting.
4. Usage text lists every verb; an unknown verb exits 2 with usage.

## Acceptance

- [ ] Every verb round-trips against a real daemon in the suite.
- [ ] Daemon down: exit 3 with the clear message on stderr and nothing on stdout.
- [ ] --json parses and matches the socket result.
- [ ] A scripting example (spawn two agents, post into a room, read it back) runs as one suite test.

## Out of scope

- The daemon's own `daemon` verb internals (already shipped), and any TUI behavior.

## Depends on

- T-502

## Unblocks

- Nothing.
