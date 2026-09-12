# T-1627 — Message and plan bodies render as Markdown with mermaid diagrams

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

What an agent writes in a room reads the way it was meant: GitHub-flavored Markdown for messages and plans, fenced code kept as code with diff lines tinted, and mermaid fences drawn as diagrams in the console's own palette, with a diagram that fails to parse shown as its source rather than a blank.

## Read first

- [The message component and its body renderer](../../../web/src/console/Message.tsx)
- [The build that produces the single served bundle](../../../web/vite.config.ts)
- [The static allowlist the daemon serves](../../../src/daemon/console-api.ts)

## Files this task may change

- `web/src/console/Markdown.tsx`
- `web/src/console/Message.tsx`
- `web/vite.config.ts`
- `web/package.json`
- `web/bun.lock`
- `src/console/app.js`
- `src/console/style.css`
- `tests/console-client.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`web/src/console/Markdown.tsx`](../../../web/src/console/Markdown.tsx) | New | react-markdown with remark-gfm; code, diff, mermaid (lazy, theme-aware), mentions in prose; HTML stays text. |
| [`web/src/console/Message.tsx`](../../../web/src/console/Message.tsx) | Edited | MessageBody delegates to Markdown; the hand-rolled line parser is gone. |
| [`web/vite.config.ts`](../../../web/vite.config.ts) | Edited | inlineDynamicImports, so mermaid's lazily loaded modules live inside the one served app.js. |
| [`web/package.json`](../../../web/package.json) | Edited | react-markdown, remark-gfm, mermaid. |
| [`web/bun.lock`](../../../web/bun.lock) | Edited | Locked. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Rebuilt. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Rebuilt. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | A body with a heading, table, task list, inline code, HTML, a diff fence, and a mermaid fence renders each as intended. |

## Steps

1. Replace the line-based renderer with react-markdown and GFM, keeping the code-block styling and diff tint as custom components.
2. Render a mermaid fence through mermaid.render on first sight, in the console's light or dark theme, falling back to the source on error.
3. Keep the bundle a single file, since the daemon serves an allowlist, by inlining dynamic imports.

## Acceptance

- [x] A message with a heading, a table with bold, a checked task, inline code, raw HTML, a diff fence, and a mermaid fence renders the heading, the table, the checkbox, the code, the HTML as text, the tinted diff line, and an SVG with the diagram's labels.
- [x] The browser suite stays green with no client-side errors.

Evidence:

| Claim | Anchor |
|---|---|
| Markdown and mermaid rendering in the browser | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |

## Out of scope

- Splitting mermaid into a separately served chunk: the daemon's static allowlist is deliberate, and the bundle stays one file at the cost of size.

## Depends on

- T-1626

## Unblocks

- Nothing.
