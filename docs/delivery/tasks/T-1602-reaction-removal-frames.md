# T-1602 — Reaction removal frames

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Reaction removals propagate through the WebSocket so an external chat_unreact updates an open console.

## Read first

- [Console WebSocket poller](../../../src/daemon/console-api.ts)
- [Console reaction renderer](../../../src/console/app.js)
- [Console browser suite](../../../tests/console-client.test.ts)

## Files this task may change

- `src/daemon/console-api.ts`
- `src/console/app.js`
- `tests/console-api.test.ts`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Diffs reaction state both ways and emits a boolean reacted frame. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Applies reaction additions and removals from WebSocket frames. |
| [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) | Edited | Asserts the reacted field is boolean and removals emit. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Browser-proves an out-of-band unreact clears an open chip. |

## Steps

1. Make the room poller diff reactions in both directions and emit reacted: true or false for each change.
2. Apply both values in the console without requiring a snapshot refetch.
3. Pin the frame schema and browser behavior in the API and client suites.

## Acceptance

- [x] Browser-proven: an out-of-band unreact clears the chip in an open console.
- [x] The frame schema asserts reacted is boolean.

Evidence:

| Claim | Anchor |
|---|---|
| two-way poller diff with floor guard; frames carry reacted:boolean | [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) |
| out-of-band unreact clears the chip without reload | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
| Commit | `75efdd3` |

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- T-1604
