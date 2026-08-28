# T-1006 — In-process worker path for cheap agents

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-10](../epics/EP-10-production-wiring.md) | [SP-11](../sprints/SP-11-production-wiring.md) | Planned | [asset-map](../asset-map.md) |

## Goal

Short-lived or cheap agents run in-process via the SDK behind the same worker interface, when process-per-agent proves heavy in practice.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Worker lifecycle](../../../src/worker/lifecycle.ts)
- [ADR-001: RPC subprocess workers](../../../docs/delivery/adr/ADR-001-rpc-subprocess-workers.md)

## Files this task may change

- `src/worker/lifecycle.ts`
- `src/daemon/main.ts`
- `tests/worker-inprocess.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | An in-process backend satisfying SupervisedWorker behind the existing interface. |
| [`src/daemon/main.ts`](../../../src/daemon/main.ts) | Edited | The spawn path selects the backend from the definition or a daemon flag. |
| `tests/worker-inprocess.test.ts` (to be created) | New | The same supervisor contract suite drives both backends. |

## Steps

1. Pick this up WHEN the RPC-per-agent cost is measured to matter (memory, startup latency at many peers) — not before; ADR-001 chose crash isolation first.
2. Implement the in-process session behind SupervisedWorker; no sandbox applies to it, so it is for trusted cheap agents only and `/agents` must never show a shield for one.
3. The supervisor contract suite runs against both backends, so the optimization cannot fork behavior.

## Acceptance

- [ ] Both backends pass the same supervisor contract suite.
- [ ] An in-process worker never shows the sandbox shield.
- [ ] The default stays RPC subprocess.

## Out of scope

- Sandboxing in-process workers — impossible; the shield rules make that visible rather than implied.

## Depends on

- T-401

## Unblocks

- Nothing.
