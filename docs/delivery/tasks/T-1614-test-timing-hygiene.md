# T-1614 — Deadline-bounded test timing

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

Async tests wait on observable behavior with deadline-bounded polls instead of fixed sleeps, including unread recovery across the socket reconnect race.

## Read first

- [Daemon timing wait](../../../tests/daemon-main.test.ts)
- [Gateway timing wait](../../../tests/gateway-client.test.ts)
- [Toolbelt timing wait](../../../tests/toolbelt.test.ts)
- [Unread reconnect test](../../../tests/console-client.test.ts)

## Files this task may change

- `tests/daemon-main.test.ts`
- `tests/gateway-client.test.ts`
- `tests/toolbelt.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) | Edited | Replaces Bun.sleep(60) with a deadline-bounded observable poll. |
| [`tests/gateway-client.test.ts`](../../../tests/gateway-client.test.ts) | Edited | Replaces fixed setTimeout(400) with a deadline-bounded observable poll. |
| [`tests/toolbelt.test.ts`](../../../tests/toolbelt.test.ts) | Edited | Replaces Bun.sleep(75) with a deadline-bounded observable poll. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Retries the unread post after reconnect to survive the socket TOCTOU. |

## Steps

1. Replace the three named fixed waits with deadline-bounded polling helpers that report the unmet behavior on timeout.
2. Make the unread test retry its post after reconnect instead of betting on one socket state observation.
3. Search the four files for remaining fixed sleeps outside poll helpers and spot-verify one replacement fails when its behavior is reverted.

## Acceptance

- [ ] No Bun.sleep/fixed setTimeout remains in those four files outside deadline-bounded poll helpers.
- [ ] Each replaced wait fails fast when the behavior it waits for is broken, with one spot-verified by revert.

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
