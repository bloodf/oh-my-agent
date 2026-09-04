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

![oh-my-agent runtime: TUI, CLI, and browser console reach the daemon over a loopback control socket; the daemon owns workers, rooms, SQLite, and the credential gateway](runtime.svg)

## First run

![First run workflow: omp install, TUI load, daemon boot, status, agent create, then spawn](first-run.svg)

## Mention wakeup

![Mention wakeup sequence: a console post mentions a parked peer, the supervisor persists and prompts, the worker replies, the live feed updates](mention-wakeup.svg)

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
node "$TMP/extract-svg.mjs" "$TMP/runtime.html" "$DIAGRAMS/runtime.svg"
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

`extract-svg.mjs` pulls the diagram SVG out of the HTML and inlines dark-theme CSS so GitHub markdown can display it. Keep the HTML under `/tmp`. Never write `.html` into the repo.

## Rules

- JSON is the source of truth. Change the JSON, then regenerate SVG.
- Never hand-edit SVG.
- Render HTML only under `/tmp`. Do not commit HTML.
- Markdown embeds `.svg` with alt text. Do not use mermaid for these maps.
