# Brand and product imagery

These assets match the conversation-first web workspace. Editable UI tokens live in `web/src/index.css`; `src/console/style.css` is generated.

## Identity

Use the flat conversation mark, system-sans `oh-my-agent` wordmark, neutral near-black surfaces, sky-blue accent (`#7dd3fc`), and aubergine (`#451b52`) brand field. Preserve high text contrast and uniform scaling. The previous glowing-diamond illustrations are retired.

## Files

| File | Role |
|---|---|
| [logo.svg](logo.svg), [logo.png](logo.png) | Conversation app mark; PNG is 1024 × 1024 |
| [mark.svg](mark.svg), [mark.png](mark.png) | Compact mark; PNG is 1024 × 1024 |
| [wordmark.svg](wordmark.svg) | Name lockup |
| [favicon.svg](favicon.svg) | Small browser mark |
| [banner.png](banner.png) | 1280 × 720 branded product introduction, not a UI screenshot |
| [social.png](social.png) | 1280 × 720 social card, not a UI screenshot |
| [console.png](console.png) | Actual rendered current conversation UI with isolated demonstration data |
| [collaboration.png](collaboration.png) | Actual rendered current channel/thread UI with isolated demonstration data |

Product shots come from real React Storybook components after `bun run console:build`. Demonstration messages are not claims of live agent activity. Never draw invented controls, dashboards, usage totals, or conversation screenshots. Never capture operator tokens, credentials, or private user content.

Architecture illustrations remain source-backed diagrams under [../diagrams](../diagrams/README.md); they are not substitutes for product captures. Regenerate from their JSON source and resolve the SVG presentation styles for repository rendering.

## Embedding

Use repository-relative paths and describe the current visible content in alt text. Scale uniformly. Do not add glows, extra orbit decoration, or stretch the mark. Keep reasonable clear space around the wordmark.
