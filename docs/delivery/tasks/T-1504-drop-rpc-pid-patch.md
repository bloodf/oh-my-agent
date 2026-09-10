# T-1504 — Remove the RpcClient.pid patch

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-15](../epics/EP-15-upstream-filings.md) | [SP-16](../sprints/SP-16-upstream-hygiene.md) | Done | [asset-map](../asset-map.md) |

## Goal

The patchedDependencies entry and the patch file are gone because the daemon no longer needs the accessor: each worker's and web chat's launch shim records its own pid. Upstream still ships no RpcClient.pid, so the resolved peer's contract state stays 'pid absent', now without degraded supervision.

## Read first

- [patchedDependencies](../../../package.json)
- [Where the patch was introduced](../../../docs/delivery/tasks/T-1003-worker-pid-on-the-wire.md)
- [The shim pid record that replaces it](../../../docs/delivery/tasks/T-1619-runtime-liveness-review.md)

## Files this task may change

- `package.json`
- `bun.lock`
- `tests/pack.test.ts`
- `tests/consumer-install.test.ts`
- `.github/workflows/release.yml`
- `src/worker/lifecycle.ts`
- `src/daemon/web-chats.ts`
- `docs/guide/faq.md`
- `docs/develop/setup.md`
- `docs/develop/modules.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`package.json`](../../../package.json) | Edited | patchedDependencies and the patches allowlist entry are removed; the dev dependency moves to 18.1.17 and the peer floor to 18.1.0, which admits the OMP an operator runs today. |
| [`bun.lock`](../../../bun.lock) | Edited | Relocked on the unpatched 18.1.x dependency. |
| [`tests/pack.test.ts`](../../../tests/pack.test.ts) | Edited | Created by T-1301; asserts nothing under patches/ is packed. |
| [`tests/consumer-install.test.ts`](../../../tests/consumer-install.test.ts) | Edited | Created by T-1306; the 'absent' assertion stays and now states why supervision is not degraded. |
| [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) | Edited | Created by T-1303; the smoke step no longer names degraded supervision. |
| [`src/worker/lifecycle.ts`](../../../src/worker/lifecycle.ts) | Edited | Comments name the shim record, not a patch, as the pid source outside an upstream accessor. |
| [`src/daemon/web-chats.ts`](../../../src/daemon/web-chats.ts) | Edited | Same, for web chat liveness. |
| [`docs/guide/faq.md`](../../../docs/guide/faq.md) | Edited | The degraded-supervision entry becomes an explanation of the shim pid record. |
| [`docs/develop/setup.md`](../../../docs/develop/setup.md) | Edited | The Patches section is removed. |
| [`docs/develop/modules.md`](../../../docs/develop/modules.md) | Edited | The patches/ row is removed. |

## Steps

1. Taken on the operator's decision rather than on an upstream release: T-1619 made pid reporting independent of the accessor, and the suites were verified against unpatched OMP 18.1.17 first.
2. Delete the patch file and the patchedDependencies entry, drop patches from the files allowlist, move the dev dependency to 18.1.17 and the peer floor to 18.1.0, and relock.
3. Update the consumers of patches/ and the pid contract wording: the pack test, the release workflow step, the consumer-install assertion's comment, and the contributor docs.

## Acceptance

- [x] No patchedDependencies entry and no patch file remain, the patch hygiene gate passes with none, and the full suite is green on the unpatched dependency.
- [x] The pack test asserts nothing under patches/ is packed.
- [x] Worker and web chat pids are reported without the accessor, and the consumer smoke still asserts the resolved peer's 'pid absent' state.

Evidence:

| Claim | Anchor |
|---|---|
| Worker pid reported from the shim record without the accessor | [`tests/worker-lifecycle.test.ts`](../../../tests/worker-lifecycle.test.ts) |
| Web chat liveness from the shim record without the accessor | [`tests/web-workspace-security.test.ts`](../../../tests/web-workspace-security.test.ts) |
| Nothing under patches/ is packed | [`tests/pack.test.ts`](../../../tests/pack.test.ts) |
| Patch hygiene passes with no patches | [`scripts/check-patches.py`](../../../scripts/check-patches.py) |
| The patch being removed was added in | `d374d76` |

## Out of scope

- An upstream RpcClient.pid accessor. When one ships, the consumer smoke's 'absent' assertion fails and flags it; the shim record can then stay as the fallback or go.

## Depends on

- T-1502
- T-1619

## Unblocks

- Nothing.
