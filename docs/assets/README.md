# Brand assets

Source files for the oh-my-agent mark, wordmark, and product shots. Colors match the console tokens in `src/console/style.css`.

## Palette

| Token | Hex | Use |
|---|---|---|
| `--surface-0` | `#0f1115` | Backgrounds, tiles, GitHub hero plates |
| `--accent` | `#8ab9ff` | Interactive chrome, links, focus |
| `--role-agent` | `#58c4dd` | Agent authors, cyan nodes on the mark |
| `--role-you` | `#e3b341` | Human / `@you`, gold nodes on the mark |
| `--success` | `#57ab5a` | Running, healthy, confirmed |

Do not invent a second palette for slides or social. If a surface needs more paint, take it from the console `:root` block (`--surface-1`, `--text-primary`, `--danger`), not from a new hex.

## Files

| File | Role |
|---|---|
| [`logo.svg`](logo.svg) | Vector mark. Prefer this wherever the renderer is sharp (docs sites, print, app icons at arbitrary size). |
| [`logo.png`](logo.png) | Rounded app-icon raster of the mark. GitHub README header. |
| [`mark.svg`](mark.svg) | Vector square mark without wordmark. Prefer over `mark.png` where SVG renders. |
| [`mark.png`](mark.png) | Square mark without wordmark. Avatars, favicons, small tiles. |
| [`wordmark.svg`](wordmark.svg) | Vector name lockup without tagline. |
| [`favicon.svg`](favicon.svg) | Favicon. Browser tab, docs site. |
| [`banner.png`](banner.png) | Mark + wordmark + tagline on `--surface-0`. README wordmark. |
| [`social.png`](social.png) | Open Graph / social card: mark, name, one-line product claim. |
| [`console.png`](console.png) | Operator console hero. README product shot. |
| [`collaboration.png`](collaboration.png) | Rooms / multi-agent illustration. README feature plate. |

## Usage

**Background.** The mark is drawn for a dark field. Default to `--surface-0` (`#0f1115`). A light background washes out the glow and the cyan/gold nodes.

**Clear space.** Keep empty margin around the mark at least as wide as the inner diamond. Do not crowd it with other logos, badges, or body text.

**Do not recolor the mark.** Do not swap the diamond, orbits, or nodes to a campaign color. Cyan is `--role-agent`, gold is `--role-you`; those map to product meaning, not decoration.

**Do not stretch.** Scale uniformly. Do not add drop shadows, outlines, or a second orbit.

**Wordmark.** Set the name in a geometric sans, sentence case as `oh-my-agent`. Do not rewrite it as `OhMyAgent`, `OMA`, or a stylized lockup unless you are using `banner.png` or `social.png` as shipped.

**SVG vs PNG.** Use `logo.svg` when the host renders SVG (docs sites, vector design tools). Use the PNGs on GitHub README, issue templates, and social cards: GitHub rasterizes reliably, SVG in READMEs does not.

## README embedding

Relative paths from the repository root, with alt text:

```markdown
![oh-my-agent mark: a glowing diamond on a dark rounded tile, orbited by cyan and gold nodes](docs/assets/logo.png)
![oh-my-agent wordmark: hexagonal mark beside the name, tagline autonomous agents that keep working](docs/assets/banner.png)
```
