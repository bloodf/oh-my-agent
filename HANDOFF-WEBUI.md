# Handoff: whole new operator web UI

Copy everything below the line into a new AI harness session. Do not continue the current `ConsoleApp.tsx` layout. Start a **new UI process**.

---

## Mission

Design and ship a **new** operator web UI for oh-my-agent (`bloodf/oh-my-agent`).

The operator rejected the previous UIs:

1. Vanilla three/four-column HTML (`src/console` before `web/`) — unusable, cramped, broken composer.
2. First shadcn port (`web/src/ConsoleApp.tsx` on `main`, commit `c64d73d`) — still a stacked-forms port of the old IA, not a 2026 product UI.

**Do not restyle `ConsoleApp.tsx`.** Treat it as a **behavior reference** (API, IDs, websocket) only. New information architecture, new visual system, new component tree.

Success = the operator can open `/console`, use it without a guide, and say the chrome is acceptable. Browser verification is mandatory.

## Product

oh-my-agent is an OMP plugin. A detached Bun daemon owns agents, rooms, schedules, SQLite. Three clients hit the same daemon: OMP TUI, `omp-agent` CLI, **loopback browser console**.

The console is a **single-operator local tool** (Slack-like rooms with agents). Not a SaaS marketing site. Not multi-tenant. Dark, dense, keyboard-first, high-contrast.

Repo: `https://github.com/bloodf/oh-my-agent`  
Branch: `main` (as of handoff: `c64d73d` and later)  
Package: `@bloodf/oh-my-agent` npm **1.0.4** does **not** include this work until a later publish.

## New UI process (mandatory order)

Do these phases in order. Do not skip to code.

### Phase 0 — Ground

Read, do not rewrite yet:

- `web/` — current Vite + React 19 + Tailwind v4 + shadcn 4.21 radix-nova scaffold
- `web/src/lib/api.ts`, `web/src/lib/types.ts` — keep
- `web/src/ConsoleApp.tsx` — **behavior only** (API paths, IDs, events)
- `src/daemon/console-api.ts` static serving (~1485–1680)
- `tests/console-client.test.ts` — selector contract
- `docs/guide/console.md`, `docs/web-console.md`
- Official docs (fetch live, do not guess):
  - https://ui.shadcn.com/docs
  - https://ui.shadcn.com/docs/installation/vite
  - https://ui.shadcn.com/docs/components
  - https://ui.shadcn.com/docs/directory
  - https://ui.shadcn.com/r/registries.json
  - https://tailwindcss.com/docs

Run `bunx shadcn@latest docs <component>` before using a primitive.

### Phase 1 — Design brief (write it down, then build)

Write a short design plan in the session (and optionally `web/DESIGN.md`) before components:

**Audience:** one operator watching long-lived agents.

**Job:** scan rooms, read a transcript, post, steer a worker, create a peer, without leaving the keyboard.

**Layout (replace the current 3 stacked columns):** propose a 2026 operator-console IA. Suggested, not mandatory if you have a better one:

- **Primary:** transcript + composer (the product)
- **Secondary:** channel switcher as a compact rail or command palette (⌘K), not a form dump
- **Tertiary:** agent ops in a Sheet / Command / header menu — not a permanent third column of inject fields
- **Create flows:** Dialogs, not five stacked inputs under the channel list
- **Thread:** Sheet or split that does not crush the transcript
- **Auth:** centered Card, remote only
- **Empty / offline / load-failure:** designed states, not leftover boxes

**Visual (avoid AI-default looks):**

- Dark zinc/neutral OKLCH tokens (already in `web/src/index.css`)
- One accent (sky or similar) for agents; amber only for `@you`
- Geist or system-ui; Geist Mono for code/logs/IDs — no extra display serif
- Compact density (`text-sm`, `gap-2`/`p-3`)
- Visible `:focus-visible` rings
- `prefers-reduced-motion`
- AAA-ish contrast on text vs background
- No glassmorphism, no gradient mesh, no all-caps eyebrows, no numbered 01/02/03 chrome

**Do not** ship the cinematic mock in `docs/assets/console.png` (usage gauges, PID, cron wall). That is brand art, not the product.

### Phase 2 — Fetch latest shadcn + Tailwind plugins from the web

Use **latest** packages. Non-interactive CLI:

```sh
cd web
bunx shadcn@latest init -d --base radix -f   # only if re-init needed
bunx shadcn@latest add -y -o <names>
bunx shadcn@latest docs <name>
```

Current `web/components.json`: `style: radix-nova`, `baseColor: neutral`, Tailwind config blank (v4). Keep Radix (`--base radix`).

**Must use as real primitives (not raw HTML):** Button, Input, Textarea, Label, Card, Badge, ScrollArea, Separator, Dialog, AlertDialog, Sheet, DropdownMenu, Command, Popover, Tooltip, Tabs, Checkbox, Avatar, Skeleton, Alert, Sonner.

**Fetch extra from registries / plugins** (install what the design needs; skip junk):

```sh
bunx shadcn@latest search
# then add from directory namespaces, e.g.
bunx shadcn@latest add @ai-elements/...   # only if it fits agent transcripts
```

Tailwind v4 plugins via CSS `@plugin` (and package.json deps):

- `tw-animate-css` (already)
- `@tailwindcss/typography` for message bodies / markdown
- optional: `@tailwindcss/container-queries` if used

Do **not** add Next.js. This is Vite SPA.

After adding components, commit before large overwrites (`shadcn add --overwrite` clobbers local edits).

### Phase 3 — Implement the new UI

Replace `web/src/ConsoleApp.tsx` / `App.tsx` with a **split component tree**. One 1200-line file is not the new process.

Suggested tree:

```
web/src/
  main.tsx
  App.tsx                 # providers only
  console/
    ConsoleShell.tsx      # frame
    ChannelRail.tsx
    Transcript.tsx
    Message.tsx
    Composer.tsx
    ThreadPanel.tsx
    AgentMenu.tsx
    CreateChannelDialog.tsx
    CreateAgentDialog.tsx
    KillDialog.tsx
    DefinitionDialog.tsx
    AuthScreen.tsx
    useConsole.ts         # websocket + API
  lib/api.ts              # keep
  lib/types.ts            # keep
  components/ui/          # shadcn, do not hand-edit unless necessary
```

**Keep daemon API** (from `ConsoleApp.tsx` / old `app.js`):

| Action | Path |
|---|---|
| List rooms | `GET /api/channels` |
| Create room | `POST /api/channels` `{id}` |
| Messages | `GET /api/channels/:id/messages` |
| Post | `POST /api/channels/:id/messages` `{body, author:"@you", parentId}` |
| Agents | `GET /api/agents` |
| Create agent | `POST /api/agents` |
| Join/leave | `POST/DELETE /api/agents/:name/rooms` |
| Kill | `POST /api/agents/:name/kill` `{keepChildren}` |
| Logs | `GET /api/agents/:name/logs` |
| Inject | `POST /api/agents/:name/inject` `{message}` |
| Bump | `POST /api/accounts/:id/bump` `{budgetUsd}` |
| Definition | `GET/PATCH /api/agents/:name/definition` |
| Reactions | `POST /api/messages/:id/reactions/toggle` |
| WS | `/api/events?token=` (loopback) or ticket (remote) |
| Remote session | `POST /api/session` |

Token: loopback `?token=` on first HTML; remote `sessionStorage` + tickets. `document.documentElement.dataset.authMode === "remote"`.

Human author is `@you`.

**Definition editor is currently a stub** in `ConsoleApp.tsx`. The new UI must implement GET → JSON textarea `#definition-changes` → save, parser error in `#definition-error`, Escape returns focus to `.definition-edit[data-name]`.

### Phase 4 — Build pipeline (do not break the daemon)

Vite app lives in `web/`. Build **must** emit exactly:

```
src/console/index.html
src/console/app.js
src/console/style.css
```

Daemon allowlist is **only those three names** (`STATIC_FILES` in `src/daemon/console-api.ts`). Extra `/assets/*.woff2` 401s. **No extra font files.** Use `ui-sans-serif` / already-inlined CSS. `publicDir: false`.

`index.html` after build must contain:

```html
<html lang="en" class="dark">
<link rel="stylesheet" href="/style.css" />
<script type="module" src="/app.js"></script>
```

Remote bootstrap strips those tags with regex; keep `href="/style.css"` and `src="/app.js"` literal. `class="dark"` is required. Transform lives in `web/vite.config.ts`.

Scripts (repo root):

```
bun run console:dev
bun run console:build
```

`prepack` already runs `console:build`.

Root `tsconfig.json` excludes `web/`. Web typecheck: `bun run --cwd web exec tsc -b`. Biome ignores `web/` (oxlint there).

Do not add font binaries under `src/console/`.

### Phase 5 — Test ID contract

`tests/console-client.test.ts` drives a real Chrome against a live daemon. **Keep these selectors** unless you update the tests in the same PR (prefer keep):

| ID / class | Role |
|---|---|
| `#channels` | listbox |
| `.channel` + `data-id` | room option; `.active` `.unread` |
| `#composer-input` `#composer-send` | post |
| `#composer .composer-hint` | Enter / Shift+Enter copy |
| `#messages` | `role="log"`, `tabIndex=0` |
| `.message` + `data-id` | row; `.role-you` `.role-agent` `.role-system` `.grouped` |
| `.body` `.mention` `.reaction` `.mine` `.thread-open` `.timestamp` `.author` `.meta` |
| `#thread` + `hidden` when closed | `#thread:not([hidden])` when open |
| `#thread-close` `#thread-messages` `#thread-composer-input` `#thread-composer-send` |
| `#new-channel-input` `#new-channel-create` | must be **typeable without opening a dialog** (Puppeteer `page.type`) |
| `#new-agent-name` `#new-agent-description` `#new-agent-spawns` `#new-agent-rooms` `#new-agent-body` `#new-agent-create` `#new-agent-error` | same: visible enough to type |
| `#agents .agent[data-name]` `.membership-toggle` `data-member` `.definition-edit[data-name]` |
| `#notice` | membership “immediately” copy |
| `#ops` `.ops-agent[data-name]` `.ops-kill` `.ops-logs` `.ops-inject-input` `.ops-bump-input` |
| `#ops-kill-dialog[open]` native `<dialog>` | `#ops-kill-heading` `#ops-kill-detail` `#ops-kill-keep` `#ops-kill-confirm` `#ops-kill-cancel` |
| `#definition-dialog` `#definition-changes` `#definition-save` `#definition-error` `#definition-heading` |
| `#operator-auth` `#operator-token` `#operator-auth-form` `#operator-auth-error` |
| `#state` `data-state=empty\|offline\|load-failure` `.state-title` `.state-detail` `.state-action` |
| skip link to `#composer-input` |

Create-agent/channel fields can live in a **visually compact** always-mounted region (accordion open, or visually in a panel) — they must remain in the DOM and typeable. Do not put them only inside a closed Radix Dialog.

Kill dialog: native `<dialog open>` is what tests assert. Style it with shadcn tokens. AlertDialog is fine **if** you also keep `#ops-kill-dialog[open]`.

### Phase 6 — Verify

```sh
bun run console:build
bunx tsc --noEmit
bun run --cwd web exec tsc -b
bun test ./tests/console-client.test.ts
bun test ./tests/daemon-console-mount.test.ts
```

Then **browser**, not screenshot-only:

1. Boot daemon (`omp` session start auto-starts, or `bun src/daemon/main.ts daemon`)
2. Open printed console URL
3. Create channel, post, open thread, react, join/leave agent, stop with confirm, logs, inject
4. Desktop and a ~390px width
5. Keyboard: Tab to channel, Enter to open thread, Escape back, Enter to send

Replace `storybook/console` so it catalogs the **new** UI (pages / components / states), still no daemon required. `bun run storybook`.

### Phase 7 — Ship hygiene

- CHANGELOG Unreleased
- `docs/guide/console.md` — how to open, `console:dev` / `console:build`
- `bun run docs` if you touch `scripts/gen-delivery-docs.py` (T-603 owns console client)
- Commit + push (user rule). No AI attribution in commits, PRs, or comments
- Do **not** npm publish unless the operator says so
- Do **not** force-push, close PRs, or merge express-labs PRs
- Do **not** commit `.agentic/session-log/` or `HANDOFF-LINUX.md`

## Hard constraints

- Bun ≥ 1.3.14. Latest package versions.
- Single operator, loopback default. Token never in the TUI widget.
- No extra static files besides the three allowlisted names.
- E2E GitHub workflows stay `workflow_dispatch` only.
- Caveman/terse operator-facing chat; commits in normal English, user voice.
- This repo’s DinoStack mode is **opt-out** — do not start a DinoStack ticket ritual unless asked.

## Definition of done

- [ ] Written design brief exists (tokens, IA, principles) and the UI matches it
- [ ] Latest shadcn components/plugins fetched from the web, not invented
- [ ] New component tree (not a restyle of `ConsoleApp.tsx`)
- [ ] `bun run console:build` emits the three daemon files
- [ ] `tests/console-client.test.ts` and `tests/daemon-console-mount.test.ts` pass
- [ ] Operator path: `omp` → `/console` → URL works end to end in a real browser
- [ ] Storybook shows the new pages/components/states
- [ ] CHANGELOG + console guide updated; committed and pushed

## First command for the incoming harness

```sh
git log -5 --oneline
ls web/src
bun run console:build
```

Then Phase 0 reads. Then Phase 1 design. Then fetch. Then implement.
