# T-1615 — Repaint stability: identity-keyed focus, thread-pane restore, and sticky scroll

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

Every repaint site in the console preserves keyboard context: focus is restored by control identity (never by ordinal), the thread pane gets the same protection the transcript got, and a repaint never resets the scroll position of a user who scrolled up.

## Read first

- [Console client render paths](../../../src/console/app.js)
- [Browser suite](../../../tests/console-client.test.ts)
- [The ticket this extends](../../../docs/delivery/tasks/T-1104-console-focus-stability.md)

## Files this task may change

- `src/console/app.js`
- `src/console/index.html`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Focus capture/restore extracted into captureFocus/restoreFocus helpers shared by all three repaint sites; chips restore by identity (textContent/emoji), not ordinal; sticky-bottom scroll; renderChannels restores by channel identity. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Chip-identity, wrong-target rejection, scroll preservation, and channel-identity assertions; the focusInPage docstring corrected (atomic-resolve rationale, bringToFront named alongside). |
| [`src/console/index.html`](../../../src/console/index.html) | Edited only if needed | Add identity attributes on rows or controls only if restore cannot use existing DOM identity; otherwise leave this file unchanged and explain why in the implementation report. |

## Steps

1. Extract the capture/restore block from renderTranscript into captureFocus/restoreFocus helpers and apply them to all three repaint sites: renderTranscript, renderThread, and renderChannels.
2. Restore chips by textContent/emoji identity within the message row; if that identity vanished, drop focus to body or the container, never a sibling control or matches[0], and document that fallback rule in the code comment.
3. Make renderThread and renderChannels consume the same helpers, with channels restored by channel identity rather than roving index.
4. Keep scroll sticky to bottom only when the user was already at the bottom; otherwise preserve scroll position across repaint.
5. Add chip-identity restore, wrong-chip rejection, scrolled-up preservation, bottom-pinning, thread-pane restore, and channel-identity assertions; tighten the focusInPage docstring to the atomic-resolve rationale and name bringToFront alongside it as the environment fix.

## Acceptance

- [ ] Focus restore is by control identity, never by ordinal; a control whose identity vanished drops focus to the container or body, never a wrong sibling — browser-proven for transcript, thread pane, and channels.
- [ ] A scrolled-up user's position survives a repaint; a user at the bottom stays pinned.
- [ ] The repaint regression test covers transcript, thread pane, and channels, and the thread keyboard suite stays green.

## Out of scope

- Reworking the roving-tabindex model itself — only the restore identity changes.

## Depends on

- Nothing.

## Unblocks

- Nothing.
