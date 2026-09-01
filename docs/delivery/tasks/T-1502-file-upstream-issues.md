# T-1502 — File both pi-coding-agent issues

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

Both upstream issues are filed — the memo-corruption with T-1501's repro, and the RpcClient.pid accessor request — with links recorded in the tree and at the workaround sites.

## Read first

- [The repro task whose README is the issue body](../../../docs/delivery/tasks/T-1501-repro-import-meta-resolve.md)
- [Workaround site one](../../../src/worker/lifecycle.ts)
- [Workaround site two](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch)

## Files this task may change

- `scripts/gen-delivery-docs.py`
- `src/worker/lifecycle.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`scripts/gen-delivery-docs.py`](../../../scripts/gen-delivery-docs.py) | Edited | The issue URLs recorded as this task's evidence. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | The workaround comment names the upstream issue URL. |

## Steps

1. File the memo-corruption issue with T-1501's repro attached.
2. File the RpcClient.pid accessor request: one paragraph of motivation (supervision without scraping the process table) and the proposed API.
3. Record both URLs here and at the workaround and patch sites.

## Acceptance

- [ ] Both URLs are in the tree and in the code comments; a reader of either workaround reaches the issue in one click.

## Out of scope

- Nothing deferred.

## Depends on

- T-1501

## Unblocks

- Nothing.
