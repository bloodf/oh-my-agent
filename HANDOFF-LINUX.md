# Handoff: finish `oh-my-agent` on Linux with Docker

You are taking over `@bloodf/oh-my-agent`, a multi-agent orchestration daemon for the
`omp` coding harness. The repository is at commit `4d6fcd3` on `main`, in sync with
`origin/main`. **92 of 97 delivery tasks are Done.** Everything that can be built and
tested on a developer laptop has been built and tested.

Your advantage over the previous session is Linux and Docker. Two of the five remaining
blockers are blocked *only* on infrastructure a macOS laptop did not have. You can clear
them. This document tells you exactly which, exactly how, and — importantly — which ones
you must **not** pretend to clear.

---

## 1. Ground rules, in priority order

These are not style preferences. Violating any of them silently corrupts the delivery
record, which is the artifact the project is actually built around.

1. **Never hand-edit `docs/delivery/**`.** That entire tree is generated. Author changes
   in `scripts/gen-delivery-docs.py`, then run `python3 scripts/gen-delivery-docs.py`.
   All 15 gates must print `(expect 0)` and the run must end `all gates pass`. Run it
   **twice** and confirm the second run produces no diff — the generator must be
   byte-stable.

2. **Evidence means a real run, not a plausible one.** `docs/remote-exposure.md:309` says
   it in the repository's own words:

   > Do not replace `UNVERIFIED` with `PASS` from unit tests, loopback curl, config
   > inspection, or this document. Those prove daemon behavior only, not real proxy
   > behavior.

   A Docker container running real Caddy **is** real infrastructure and does count. A
   mock, a stub, a unit test, or your own reasoning does not. If you cannot run it, leave
   the row `UNVERIFIED` and say so plainly.

3. **Never run a git command from a worker/subagent.** Only the orchestrator touches git.
   Concurrent workers cause `.git/index.lock` contention. Put "NEVER run any git command"
   in every worker brief.

4. **Commits in the user's voice.** No AI attribution, no `Co-Authored-By: Claude`, no
   `Generated with` footer, no robot emoji. Focused commit per ticket. Push after each.

5. **Never force-push, never close PRs or issues, never delete branches.** If something
   seems to warrant it, ask.

6. **Non-vacuity proof for every new test.** A green test proves nothing until you have
   watched it fail. Revert the specific production line the test covers, confirm *that
   exact test* fails, restore, confirm green. Record it in the task's evidence row.

7. **`set -o pipefail` before any `cmd | tail`.** Without it, `bun test | tail -8` exits 0
   even when the suite fails. This bug shipped a false green once already.

8. **Derive counts from commands, never from prose.** `git rev-list --count`, `grep -c`.
   The previous session miscounted commits, tickets, blockers, and section counts four
   separate times, each time by trusting an earlier summary instead of re-running the
   check. The code held up under review every time; the prose did not.

---

## 2. Repository orientation

```
src/daemon/      daemon binary, control socket, pidfile      (bin: omp-agent)
src/worker/      worker lifecycle, spawn, isolation, quota
src/console/     browser console (static app.js + server)
src/extension/   omp TUI extension entry point
scripts/dogfood.ts             live-account dogfood harness
scripts/gen-delivery-docs.py   THE delivery tree generator — author here
docs/delivery/   GENERATED. 148 files. Never hand-edit.
docs/remote-exposure.md        threat model + proxy recipes + evidence table
docs/dogfooding.md             dogfood runbook
docs/web-console.md
```

Runtime: **Bun >= 1.3.14** (`engines.bun`). The repo was developed on Bun 1.3.14 and
Node v26.7.0.

Scripts you will use:

```sh
bun test --timeout 30000        # full suite: 1015 pass / 0 fail, ~395s
bun run test:fast               # skips pack, consumer-install, console-client
bun run typecheck               # tsc --noEmit
bun run lint                    # biome check .
bun run format                  # biome check --write .
bun run docs                    # python3 scripts/gen-delivery-docs.py
```

**Baseline before you touch anything.** Record these numbers and treat any deviation as
your regression, not a pre-existing one:

```sh
set -o pipefail
bun test --timeout 30000 2>&1 | tail -6     # expect 1015 pass, 0 fail, 40 files
bun run typecheck && bun run lint           # both clean
python3 scripts/gen-delivery-docs.py        # 15 gates, all (expect 0), byte-stable
```

**Formatter note:** `biome check` fails on import order in newly edited files. Run
`bunx biome check --write <files>` once, then re-run the scoped test and `biome check`.

---

## 3. The five remaining blockers, and which you can actually clear

| Task | Blocked on | Can you clear it on Linux+Docker? |
|---|---|---|
| **T-1202** proxy recipes | Three real-proxy runs | **Yes, fully.** This is your main prize. |
| **T-1205** exposure runbook | `depends_on: [T-1202]` only | **Yes** — falls out free once T-1202 closes. |
| **T-1403** first live session | Live paid accounts | **Partially.** See the honest limits below. |
| **T-1503** drop resolve walk | A *released* Bun fix | **No.** Do not fake this. |
| **T-1504** drop RpcClient.pid patch | A *released* pi-coding-agent fix | **No.** Do not fake this. |

### Why T-1503 / T-1504 are genuinely closed to you

Both wait on upstream issues the previous session filed with reproduction evidence:

- [oven-sh/bun#41201](https://github.com/oven-sh/bun/issues/41201) — resolver corruption,
  worked around by a `node_modules` walk in `resolveOmpCli` (`src/worker/lifecycle.ts:122`)
- [can1357/oh-my-pi#10597](https://github.com/can1357/oh-my-pi/issues/10597) — missing
  `RpcClient.pid` accessor, worked around by a patch in `patches/`
  (`src/worker/lifecycle.ts:401`)

The ticket text is explicit: *"an upstream filing alone does not unblock removal"* — it
needs a **released** version, not a merged PR. Your one legitimate action: check whether a
release has shipped that contains the fix.

```sh
bun pm view bun versions --json 2>/dev/null | tail -5
bun pm view pi-coding-agent versions --json 2>/dev/null | tail -5
```

If yes, do the removal properly (upgrade, delete the workaround, raise the floor in
`engines.bun` or the `pi-coding-agent` dependency floor, prove the suite green on the
upgraded runtime). If no — and this is the likely outcome — **leave both Blocked** and say
so. Deleting a workaround because upstream *merged* a fix will break every user still on
the released version.

---

## 4. T-1202 — your main objective

**Goal.** Three proxy recipes in `docs/remote-exposure.md` each have an `UNVERIFIED` row in
the evidence table at lines ~296–309. Convert each to a dated PASS backed by a real run.

**Acceptance, verbatim from `docs/delivery/tasks/T-1202-tls-termination.md`:**

> - Each usable HTTPS recipe's three checks appear verbatim in the doc and are mirrored by
>   suite assertions; the SSH-only configuration (SSH with no paired TLS/auth proxy) is
>   explicitly rejected, distinct from the accepted SSH-tunnel-with-loopback-Caddy recipe.
> - **Each usable HTTPS recipe is verified once end-to-end against a real proxy, with the
>   date and versions recorded in the doc.**
> - `omp-agent console` prints a URL that is correct when the daemon sits behind the
>   documented proxy.
> - Remote mode with the console enabled and no external origin configured fails before the
>   pidfile or any listener opens; a headless remote daemon (`OMA_CONSOLE=0`) boots without
>   one, and loopback mode is unaffected.

Note the shape: acceptance is **per-recipe**. One run converts one row. All three rows must
be real before the ticket closes. **Do not close T-1202 on a partial.**

The three recipes, with headings already in the doc:

1. **`## Caddy with public TLS`** — fully dockerizable. Caddy with an internal CA in one
   container, daemon in another, on a user-defined bridge network.
2. **`## tailscale serve`** — needs a real tailnet and auth key. If you have one, run it. If
   not, leave the row `UNVERIFIED` and say why. A `tailscaled` in userspace-networking mode
   inside a container works, but it needs a genuine `TS_AUTHKEY`.
3. **`## SSH tunnel with loopback Caddy`** — dockerizable with an `sshd` container plus a
   loopback Caddy. Read the three sub-headings (`Remote terminal 1: daemon`,
   `Remote terminal 2: Caddy`, `Operator terminal: CA trust and tunnel`) and mirror that
   topology as containers.

**Read `docs/remote-exposure.md` end to end before building anything.** Each recipe already
specifies three checks that must appear verbatim; your run must exercise those exact checks,
not checks you invent.

**Evidence you must record per recipe:** UTC date, exact tool version (`caddy version`,
`tailscale version`, `ssh -V`), and the result. Then encode it in
`scripts/gen-delivery-docs.py`, regenerate, and confirm byte-stability.

### Docker sketch (adapt to the real doc, do not copy blindly)

```dockerfile
# Dockerfile.oma-test
FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 curl ca-certificates openssh-client git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
```

```yaml
# compose.proxy-test.yml
services:
  daemon:
    build: { context: ., dockerfile: Dockerfile.oma-test }
    environment:
      OMA_REMOTE: "1"
      OMA_CONSOLE_ORIGIN: "https://oma.test"
    command: ["bun", "src/daemon/main.ts", "start", "--foreground"]
  caddy:
    image: caddy:2
    volumes: [./Caddyfile.test:/etc/caddy/Caddyfile:ro]
    depends_on: [daemon]
```

Use Caddy's `tls internal` and trust the CA inside the client container — do not chase a
public ACME cert. Internal CA is still real TLS through real Caddy, which is what the
acceptance asks for.

**A trap worth naming.** Remote mode refuses to boot when the console is enabled and
`OMA_CONSOLE_ORIGIN` is unset — deliberately, before the pidfile or any listener opens, per
ADR-012. If your container exits instantly with a preflight error, that is the daemon
working correctly. Set the origin, or set `OMA_CONSOLE=0` for a headless remote run.

---

## 5. T-1205 — free once T-1202 closes

Its own acceptance already passes and it reviewed 0 Critical / 0 Major. It is Blocked
*solely* by `depends_on: [T-1202]`. When T-1202's three rows are real, re-verify T-1205's
two acceptance lines still hold, then flip it with an evidence row. Do not flip it early.

---

## 6. T-1403 — the honest version

The dogfood harness is real and executable: `scripts/dogfood.ts`, 29 KB, driven by these
environment variables (extracted from the source, not guessed):

```
DOGFOOD_ACCOUNT            DOGFOOD_ACCOUNT_ALLOWLIST   DOGFOOD_MAX_BUMP_USD
DOGFOOD_BUMP_USD           DOGFOOD_ROOM                DOGFOOD_SESSION_ID
DOGFOOD_PARENT             DOGFOOD_PARENT_DEFINITION   DOGFOOD_SESSION_LOG
DOGFOOD_CHILD              DOGFOOD_CHILD_DEFINITION    DOGFOOD_STEP_TIMEOUT_MS
DOGFOOD_EDIT_DOC           DOGFOOD_INJECT_TEXT         DOGFOOD_SCHEDULE_INDEX
```

Invocation from the runbook:

```sh
DOGFOOD_ACCOUNT_ALLOWLIST=<account> DOGFOOD_MAX_BUMP_USD=5 bun scripts/dogfood.ts
```

The allowlist and the spend ceiling refuse before any live verb; cleanup always
cascade-kills and disarms.

**The limit you must respect.** T-1403's step 1 says *"Pick this up WHEN the operator's live
accounts are ready."* A Docker container does not make an account ready. If you have real
credentials and the user has authorized spend, run it. Otherwise you may run the harness
against the durindoor gateway below to exercise the *mechanics*, but that is **not** the
live-account session the ticket describes, and you must not mark T-1403 Done on it. Record
what you actually ran, in those words.

Acceptance requires the session record enumerate every runbook step as pass/finding/skipped
— *"'no findings' is a positive per-step claim, not silence."* Every finding becomes a task
entry in the generator with the nine-heading contract, then regenerate twice.

---

## 7. Configuring `omp` with durindoor inside Docker

Verified live from this machine: the gateway answers with **70 models** and all four role
models resolve.

**Harness:** `omp/18.1.4`. Config root `~/.omp`, agent config at `~/.omp/agent/`.

**Provider definition** — `~/.omp/agent/provider-discovery.json`:

```json
{
  "version": 1,
  "cacheTtlMs": 86400000,
  "providers": [
    {
      "id": "durindoor",
      "name": "DurinDoor",
      "enabled": true,
      "baseUrl": "https://llm.amoena.ai/v1",
      "api": "openai-completions",
      "discovery": { "format": "openai", "path": "/models", "timeoutMs": 15000 },
      "credential": {
        "kind": "command",
        "value": "/bin/cat /root/.omp/agent/secrets/durindoor-api-key"
      },
      "headers": { "User-Agent": "durindoor-native/1.0" },
      "defaults": {
        "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128000,
        "maxTokens": 8192
      },
      "overrides": {}
    }
  ]
}
```

Note `credential.kind` is `command` — it shells out to read the key file. **Fix the path for
the container's user.** On the source machine it is `/Users/heitor/...`; in a root container
it must be `/root/.omp/agent/secrets/durindoor-api-key`. A stale absolute path is the single
most likely reason your container shows an empty model list.

**Selection** — `~/.omp/agent/settings.json`:

```json
{ "defaultProvider": "durindoor", "modelProviderOrder": ["durindoor"] }
```

**The key.** 36 bytes, mode `0600`, at `~/.omp/agent/secrets/durindoor-api-key`. There is
also a native extension at `~/.omp/agent/extensions/durindoor/` (`index.ts`,
`package.json`, `README.md`, `index.test.ts`).

**Never bake the key into an image layer.** Mount it at runtime:

```sh
docker run --rm \
  -v "$HOME/.omp/agent/secrets/durindoor-api-key:/root/.omp/agent/secrets/durindoor-api-key:ro" \
  -v "$PWD/omp-config/provider-discovery.json:/root/.omp/agent/provider-discovery.json:ro" \
  -v "$PWD/omp-config/settings.json:/root/.omp/agent/settings.json:ro" \
  oma-test bash
```

Verify inside the container before trusting anything downstream:

```sh
curl -s -H "Authorization: Bearer $(cat /root/.omp/agent/secrets/durindoor-api-key)" \
  https://llm.amoena.ai/v1/models | python3 -c \
  "import json,sys; print(len(json.load(sys.stdin)['data']),'models')"
# expect: 70 models
```

An empty selector in `omp` almost always means the credential command path is wrong for the
container, not that the gateway is down.

### Worker dispatch

Workers run through `omp` as **background bash jobs**, never `tmux`. Pass the brief via an
environment variable, never inline quoting:

```sh
omp -p --model durindoor/cx/gpt-5.6-sol --thinking high "$BRIEF"
```

| Role | Model | Verified present |
|---|---|---|
| Coding | `durindoor/cx/gpt-5.6-sol` | yes |
| Complex coding | `durindoor/cc/claude-opus-5` | yes |
| Plans | `durindoor/cc/claude-fable-5` | yes |
| Adversarial review | `durindoor/minimax/MiniMax-M3` | yes |

`claude-opus-5` returned a 429 rate limit once; fall back to Sol.

Every brief must carry: repo path, ticket path, an explicit allowed-files list, TDD
red-first, **"NEVER run any git command"**, and one scoped gate the worker may run (its own
test file only). One file-owner per lane — check ticket file lists for overlap before
dispatching in parallel, and serialize lanes that share a file.

**Reviewer 403s are infrastructure failures, not stop conditions.** Bedrock returned
`HTTP 403: security token invalid` for worker-dispatched reviewers. Dispatch the MiniMax
reviewer yourself from the orchestrator instead.

---

## 8. Definition of done for your session

Ship each ticket the same way the previous 17 shipped:

1. Real gate run — the acceptance criteria as written, not a proxy for them.
2. Adversarial review via `durindoor/minimax/MiniMax-M3`, 0 Critical / 0 Major.
3. Evidence rows authored in `scripts/gen-delivery-docs.py`, regenerated, byte-stable.
4. Focused commit in the user's voice.
5. Push.

Full suite green before you claim anything: **1015 pass / 0 fail**, `tsc` clean, `biome`
clean, generator 15/15.

### The three things the user must do — surface, do not attempt

- **Enable private vulnerability reporting** (Settings → Security), or the `SECURITY.md`
  link 404s.
- **Add repository topics**: `ai-agents`, `bun`, `typescript`, `multi-agent`.
- **Publish to npm.** `@bloodf/oh-my-agent@0.1.0` is unpublished, so the README quickstart
  does not run for anyone yet. The release workflow is ready via **manual dispatch** with
  `publish: true` — E2E workflows are manual-trigger only by standing user rule, which
  overrode a ticket that had specified a tag-push publish.

### One loose end

`.agentic/session-log/bloodf.jsonl` is untracked. `.gitignore:20` un-ignores it
(`!.agentic/session-log/**`), so it is intended to be repo-visible, but it contains Aug
27–28 telemetry — developer ID, session UUIDs, token counts — predating this work, mode
`0600`. **Do not commit or delete it unilaterally.** Ask.

---

## 9. What good looks like

The honest outcome of your session is most likely:

- **T-1202 Done** with three real dated proxy runs, or **partially advanced** with the rows
  you genuinely ran marked PASS and the rest still `UNVERIFIED`.
- **T-1205 Done**, following T-1202.
- **T-1403** advanced only as far as real credentials allow, clearly labelled.
- **T-1503 / T-1504 still Blocked**, with a one-line note on whether a fix has shipped.

That would take the project from 92/97 to 94/97 with two genuinely closed blockers.

An outcome where all five flip to Done is almost certainly wrong, and will be caught: the
evidence table demands dates and tool versions, the generator's 15 gates check internal
consistency, and the acceptance criteria are specific enough that a fabricated PASS reads as
obviously fabricated next to a real one.

**When you cannot verify something, say so plainly and leave it Blocked.** That is a
successful outcome. A false PASS in the evidence table is worse than an empty one, because
the empty one is honest about what it does not know.
