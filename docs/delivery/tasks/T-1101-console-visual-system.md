# T-1101 — Console visual system and usability overhaul

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-11](../epics/EP-11-operator-polish.md) | [SP-12](../sprints/SP-12-operator-polish.md) | Done | [asset-map](../asset-map.md) |

## Goal

The console presents like a product: one coherent design system behind every pane, state, and control.

## Read first

- [Console client](../../../src/console/app.js)
- [Console guide](../../../docs/web-console.md)
- [Browser suite](../../../tests/console-client.test.ts)

## Files this task may change

- `src/console/index.html`
- `src/console/app.js`
- `src/console/style.css`
- `tests/console-client.test.ts`
- `docs/web-console.md`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Design tokens (type scale, spacing, color, dark theme) consumed by every rule — no per-component restyling. |
| [`src/console/index.html`](../../../src/console/index.html) | Edited | Semantic structure the tokens and landmarks hook into. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Render paths produce the new structure; states (loading/empty/error/offline) are first-class. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Visual-system assertions: tokens applied, states render, no inline ad-hoc styles. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | The client section describes the system, not a screenshot in words. |

## Steps

1. Define the token layer first: typography scale, spacing rhythm, a dark color system with semantic names (surface, text, accent, danger, success, muted), and component states. Every rule consumes tokens; a hardcoded pixel/hex outside tokens fails the suite.
2. Message rendering: author identity with role tint, grouped consecutive messages from one author, timestamps, readable body measure, code/preview affordance.
3. States as first-class screens: connecting, empty channel, daemon offline, load failure — each with a next action.
4. Composer: multiline with send affordance and visible keyboard hint; channel list with unread-style affordance (visual only, no cursor semantics).
5. Thread pane gets the same system treatment rather than its own dialect.

## Acceptance

- [x] All styling resolves through the token layer; the suite fails on a hardcoded color or pixel outside tokens.
- [x] Every state (connecting, empty, offline, error) renders with a next action, browser-proven.
- [x] The dependency-free constraint holds: no new runtime dependency, no build step.

Evidence:

| Claim | Anchor |
|---|---|
| Token layer and the system-wide client | [`src/console/style.css`](../../../src/console/style.css) |
| Browser suite, 28 tests incl. token and state assertions | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- The accessibility layer itself (ARIA, focus, keyboard), which is T-1102 built on this system.

## Depends on

- T-603

## Unblocks

- T-1102
