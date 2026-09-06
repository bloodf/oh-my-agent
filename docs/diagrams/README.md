# Archify diagrams

JSON is the source. SVG is the committed render used in markdown. Never hand-edit SVG. HTML artifacts are forbidden in this repo.

Embed the `.svg` with alt text. Do not paste mermaid for these maps.

## Index

| Diagram | Source | Rendered | Shows |
|---|---|---|---|
| Runtime | [`runtime.architecture.json`](runtime.architecture.json) | [`runtime.svg`](runtime.svg) | System runtime |
| First run | [`first-run.workflow.json`](first-run.workflow.json) | [`first-run.svg`](first-run.svg) | Install to first spawn |
| Mention wakeup | [`mention-wakeup.sequence.json`](mention-wakeup.sequence.json) | [`mention-wakeup.svg`](mention-wakeup.svg) | Mention wakeup |
| Worker lifecycle | [`worker-lifecycle.lifecycle.json`](worker-lifecycle.lifecycle.json) | [`worker-lifecycle.svg`](worker-lifecycle.svg) | Peer states |
| Credential path | [`credential-path.dataflow.json`](credential-path.dataflow.json) | [`credential-path.svg`](credential-path.svg) | Credential gateway |
| Isolation | [`isolation.architecture.json`](isolation.architecture.json) | [`isolation.svg`](isolation.svg) | Isolation layers |

## Runtime

![Conversation workspace runtime: browser uses loopback HTTP and WebSocket; TUI and CLI use the Unix socket; native chats use temporary storage while agents and rooms retain durable state](runtime.svg)

## First run

![First run: install plugin, start OMP, daemon autostarts, open console, create an agent or bot, explicitly Start](first-run.svg)

## Mention wakeup

![Mention wakeup: browser posts through Console API, room store persists, supervisor prompts agent, WebSocket updates conversation](mention-wakeup.svg)

## Worker lifecycle

![Worker lifecycle: defined, running, working, parked, quota parked, resume, stop, and child cascade](worker-lifecycle.svg)

## Credential path

![Credential path: vault token stays in the daemon; workers receive a scoped gateway bearer; spend is account-filtered](credential-path.svg)

## Isolation

![Isolation layers: OS sandbox, write isolation, and convention scoping](isolation.svg)

## Regenerating

Edit the JSON. Validate. Render HTML into `/tmp`. Extract SVG. Leave HTML out of the tree.

Run from the repository root. `--quality showcase` matches `meta.quality_profile` in every source file.

```sh
ARCHIFY="$HOME/.claude/skills/archify/bin/archify.mjs"
DIAGRAMS=docs/diagrams
TMP=/tmp/oma-archify

node "$ARCHIFY" validate architecture "$DIAGRAMS/runtime.architecture.json" --quality showcase --json
node "$ARCHIFY" render architecture "$DIAGRAMS/runtime.architecture.json" "$TMP/runtime.html" --quality showcase
node scripts/export-diagram-svg.mjs "$TMP/runtime.html" "$DIAGRAMS/runtime.svg"
```

Repeat with the matching Archify type:

| Source | Type | HTML in `/tmp` | SVG in this folder |
|---|---|---|---|
| `runtime.architecture.json` | `architecture` | `runtime.html` | `runtime.svg` |
| `first-run.workflow.json` | `workflow` | `first-run.html` | `first-run.svg` |
| `mention-wakeup.sequence.json` | `sequence` | `mention-wakeup.html` | `mention-wakeup.svg` |
| `worker-lifecycle.lifecycle.json` | `lifecycle` | `worker-lifecycle.html` | `worker-lifecycle.svg` |
| `credential-path.dataflow.json` | `dataflow` | `credential-path.html` | `credential-path.svg` |
| `isolation.architecture.json` | `architecture` | `isolation.html` | `isolation.svg` |

`scripts/export-diagram-svg.mjs` extracts the diagram SVG and inlines the neutral dark UI palette and typography for GitHub Markdown. Keep intermediate HTML outside tracked documentation. The exported SVG, not the surrounding Archify viewer chrome, is the repository deliverable.

## Rules

- JSON is the source of truth. Change the JSON, then regenerate SVG.
- Never hand-edit SVG.
- Render HTML only under `/tmp`. Do not commit HTML.
- Markdown embeds `.svg` with alt text. Do not use mermaid for these maps.
