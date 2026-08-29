# T-1102 — Console accessibility to AAA standard

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-11](../epics/EP-11-operator-polish.md) | [SP-12](../sprints/SP-12-operator-polish.md) | Done | [asset-map](../asset-map.md) |

## Goal

The console is fully operable by keyboard, readable by a screen reader, and legible at AAA contrast.

## Read first

- [Console client](../../../src/console/app.js)
- [Browser suite](../../../tests/console-client.test.ts)

## Files this task may change

- `src/console/index.html`
- `src/console/app.js`
- `src/console/style.css`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/index.html`](../../../src/console/index.html) | Edited | Landmarks, skip links, semantic lists, labeled regions. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | ARIA roles/states on dynamic content, focus management on view changes, keyboard bindings for every action. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Visible focus, AAA contrast tokens, reduced-motion variant. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | The a11y assertion battery below. |

## Steps

1. Landmarks and semantics: nav/main/complementary regions, channels as a listbox of options, messages as a log with polite live updates, composer a labeled textbox, thread pane a complementary region with a labeled close.
2. Full keyboard operation: channel switching, message scrolling, reaction toggle, reply open/close, post send, and focus that is always visible and never trapped.
3. Focus management: opening the thread pane moves focus in, closing returns it; a daemon-offline state moves focus to the retry affordance.
4. Contrast measured against AAA for body and interactive text; a prefers-reduced-motion variant removes non-essential animation.

## Acceptance

- [x] The suite drives every flow keyboard-only in a real browser: no pointer event needed for any of the above.
- [x] Roles, names, and states asserted on the live DOM (listbox/option, log, status, alert).
- [x] Focus order is asserted on open/close of the thread pane and on the offline state.
- [x] Contrast is computed from the resolved styles and meets the declared ratio.

Evidence:

| Claim | Anchor |
|---|---|
| Landmarks, roles, focus, keyboard model in the client | [`src/console/app.js`](../../../src/console/app.js) |
| A11y battery in the browser suite, 38 tests | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Screen-reader verification with a real SR binary; the assertions are DOM-level, not auditory.

## Depends on

- T-1101

## Unblocks

- Nothing.
