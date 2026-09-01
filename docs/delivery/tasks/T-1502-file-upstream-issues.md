# T-1502 — File both pi-coding-agent issues

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

Both upstream issues are filed — the resolver corruption with T-1501's repro, on the tracker the control outcome selects, and the RpcClient.pid accessor request — with links recorded in the tree and at the code sites that can carry them.

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
| [`scripts/gen-delivery-docs.py`](../../../scripts/gen-delivery-docs.py) | Edited | The issue URLs recorded as this task's evidence, in the claim text. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | The workaround comment and the WorkerHandle.pid getter site name the upstream issue URLs; the patch file itself carries no comment (patch hygiene, T-1305). |

## Steps

1. File the resolver issue with T-1501's repro attached, on the tracker the control outcome selects: oven-sh/bun if the bare-hook control reproduces the corruption, oh-my-pi if it doesn't.
2. File the RpcClient.pid accessor request: one paragraph of motivation (supervision without scraping the process table), the proposed API as the patch's src getter verbatim, and a note on which entry point (src vs dist) executes at runtime; live pid behavior is already pinned by tests/worker-lifecycle.test.ts.
3. Record both URLs in this task's evidence and at the code carriers — the workaround comment and the WorkerHandle.pid getter site in src/worker/lifecycle.ts; the patch file itself cannot carry a URL comment.
4. Evidence anchors are in-repo paths or commit shas (a bare URL renders as non-linkable text); the issue URL goes in the claim text.

## Acceptance

- [ ] Both URLs are in the tree and in the code comments; a reader of either workaround reaches the issue in one click.

## Out of scope

- Nothing deferred.

## Depends on

- T-1501

## Unblocks

- T-1503
- T-1504
