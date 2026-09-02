# Dogfooding runbook

Human operator procedure for one live-account dogfood session. [T-1402](delivery/tasks/T-1402-dogfood-harness.md) will automate only the numbered JSON scenario in §4. Daemon start, console URL retrieval, console/TUI observations, and the in-process backend boundary remain outside that mapping.

**This session touches real accounts and can spend real money.** Complete every approval and preflight check before starting.

## 0. Source-verified scope

- [`README.md`](../README.md) describes the project, requirements, and checkout development commands. It does **not** document daemon environment controls or a released-artifact install path. Installation belongs to [T-1304](delivery/tasks/T-1304-install-docs.md).
- [`src/daemon/main.ts`](../src/daemon/main.ts) honors `PI_CODING_AGENT_DIR`, disables the console when `OMA_CONSOLE=0`, and accepts a decimal `OMA_CONSOLE_PORT` from `0` through `65535`. These are the controls this runbook uses, not an exhaustive list of daemon environment variables.
- `src/daemon/main.ts` defaults `inProcessWorkers` to `false`; its shipped `runDaemon()` path does not select it. [`src/daemon/cli.ts`](../src/daemon/cli.ts) exposes no worker-backend selector.
- `src/daemon/cli.ts` defines all command forms used below. `--json` precedes each JSON-capable verb. Bare `omp-agent daemon` starts the daemon and `omp-agent console` returns a plain-text URL, so both remain manual preconditions; `daemon stop` and `daemon restart` are JSON-capable.

## 1. Operator-approved variables

Fill every value. Values are operator inputs, never defaults. Quote values containing spaces. Never place credentials or console tokens in these variables.

```sh
export DOGFOOD_ACCOUNT='<approved-account-id>'
export DOGFOOD_PARENT='<approved-parent-name>'
export DOGFOOD_CHILD='<approved-child-name>'
export DOGFOOD_PARENT_DEFINITION='<approved-parent-definition-md-path>'
export DOGFOOD_CHILD_DEFINITION='<approved-child-definition-md-path>'
export DOGFOOD_EDIT_DOC='<approved-definition-update-json-path>'
export DOGFOOD_SCHEDULE_INDEX='<approved-zero-based-schedule-index>'
export DOGFOOD_SCHEDULE_ID="${DOGFOOD_PARENT}:schedule:${DOGFOOD_SCHEDULE_INDEX}"
export DOGFOOD_BUMP_USD='<approved-bump-usd>'
export DOGFOOD_TIMEBOX_MINUTES='<approved-timebox-minutes>'
export DOGFOOD_ROOM='<#channel-or-@peer>'
export DOGFOOD_INJECT_TEXT='<approved-steering-text>'
export PI_CODING_AGENT_DIR='<approved-agent-dir-path>'
export DOGFOOD_SESSION_ID='<approved-unique-session-id>'
export DOGFOOD_SESSION_LOG=".dogfood/${DOGFOOD_SESSION_ID}.log"
```

Definition inputs have different formats:

- `$DOGFOOD_PARENT_DEFINITION` and `$DOGFOOD_CHILD_DEFINITION` are Markdown definition files with YAML frontmatter and a required non-empty Markdown body. They are not JSON.
- `agent create` accepts only these authored fields: `name`, `description`, `model`, `rooms`, `wake`, `autonomy`, `spawns`, and `body`. The frontmatter `name` must match the command name. Put fields such as `schedules` in the later `agent edit` JSON changes document, not either create document.
- `$DOGFOOD_EDIT_DOC` is a JSON object accepted by `agent edit`. Its `schedules` field must be an array of plain objects shaped `{cron, prompt, room?}`. `cron` and `prompt` are required non-empty strings; optional `room` must be a string beginning with `#` or `@`. No other schedule fields, including `id`, are accepted.
- Schedule IDs are runtime values, not authored fields. Set `$DOGFOOD_SCHEDULE_INDEX` to the approved zero-based parent `schedules` entry index; the shell derives `$DOGFOOD_SCHEDULE_ID` as `${DOGFOOD_PARENT}:schedule:${DOGFOOD_SCHEDULE_INDEX}`. The daemon registers this ID only during startup, so verify it through `omp-agent --json schedule` after §4 step 17 restarts the daemon.
- `$DOGFOOD_ROOM` must retain its leading sigil: `#channel` or `@peer` form.

## 2. Preflight and secure capture

Complete every check before daemon start.

- [ ] **Real accounts acknowledged.** Operator understands live model calls can spend real funds.
- [ ] **Account approved.** Budget owner approved exact `$DOGFOOD_ACCOUNT`; both definitions and edit document resolve to it through their model selectors.
- [ ] **Inputs approved.** Owner approved names, both Markdown definitions, edit JSON, room, schedule entry index, derived schedule ID, and steering text.
- [ ] **Bump approved and valid.** Budget owner approved exact `$DOGFOOD_BUMP_USD`. `src/daemon/cli.ts` converts it with `Number(...)`; proceed only when that result is finite, matching `Number.isFinite(...)`. Approval is not an enforced ceiling.
- [ ] **Timebox approved.** Record `$DOGFOOD_TIMEBOX_MINUTES` and wall-clock stop time. Reaching either stops new scenario work and enters §7.
- [ ] **Paths validated.** `PI_CODING_AGENT_DIR` selects intended profile; both Markdown definitions and edit JSON exist and are readable; edit document is a JSON object.
- [ ] **Room validated.** `$DOGFOOD_ROOM` starts with `#` or `@`.
- [ ] **T-1404 gap acknowledged.** No harness-enforced account allowlist, bump ceiling, abort, or unconditional cleanup exists yet.

Check clean daemon state:

```sh
omp-agent --json status
```

Exit code `3` with a message beginning `oh-my-agent daemon not running` is the required stopped state. If status succeeds, inspect exact live state:

```sh
omp-agent --json agents
omp-agent --json schedule
```

If `agents[].name` or `schedules[].id` contains any entry, **refuse to proceed**. This runbook does not authorize deleting unknown operator state. If both arrays are empty, stop and recheck:

```sh
omp-agent --json daemon stop
omp-agent --json status
```

Proceed only when final status returns exit code `3` with a message beginning `oh-my-agent daemon not running`.

Create capture before daemon start:

```sh
mkdir -p .dogfood
(umask 077 && : > "$DOGFOOD_SESSION_LOG")
chmod 600 "$DOGFOOD_SESSION_LOG"
```

Verify mode `0600` with host `stat`; refuse to proceed if it differs. Confirm `$DOGFOOD_SESSION_LOG` remains under `.dogfood/` and `.dogfood/` is excluded from commits. T-1402 owns adding that ignore rule.

Record every command and named Manual check:

```text
<UTC timestamp> | <step> | <elapsed_ms> | <command-or-Manual-label> | <exit/status> | <redacted result/evidence>
```

Capture stdout, stderr, exit code, and elapsed milliseconds. Failed commands still receive entries. Before writing or sharing:

- Replace every `?token=<value>` or `&token=<value>` with the same key and `<redacted>` value.
- Replace values after `Authorization: Bearer` and `X-Operator-Token:` with `<redacted>`.
- Replace any console token or control-socket bearer token appearing elsewhere with `<redacted>`.
- Never copy unredacted `omp-agent console` output into the log.

Keep session log mode `0600` for its lifetime.

## 3. Manual preconditions outside T-1402

These actions have no JSON result. Run them by hand and record named evidence, but do not include them in T-1402's 1:1 scenario mapping.

1. **Manual: daemon start.** Start selected profile:
   ```sh
   omp-agent daemon
   ```
   Record exit status, elapsed time, and a redacted indication that startup returned. Never record emitted token material.
2. **Manual: console URL.** Retrieve URL:
   ```sh
   omp-agent console
   ```
   Do not log raw output. Open unredacted URL in operator browser. Record only load result and UTC time.
3. **Manual: TUI ready.** Open shipped OMP TUI against same `PI_CODING_AGENT_DIR`. Record profile identity and initial visible state. Do not invent a command for an installation-specific TUI launcher.

## 4. JSON-capable management scenario

Only this numbered section maps 1:1 to T-1402. Run in order. Every command uses a JSON-capable form from `src/daemon/cli.ts`. Any failure stops progression and enters §7.

1. **Confirm daemon status.**
   ```sh
   omp-agent --json status
   ```
2. **Confirm clean baseline state.**
   ```sh
   omp-agent --json agents
   omp-agent --json schedule
   ```
   Refuse to continue if `agents[]` or `schedules[]` contains any entry. This post-start check catches persisted definitions and schedules that cannot be queried while daemon is stopped.
3. **Create and show parent.**
   ```sh
   omp-agent --json agent create "$DOGFOOD_PARENT" "$DOGFOOD_PARENT_DEFINITION"
   omp-agent --json agent show "$DOGFOOD_PARENT"
   ```
4. **Edit and re-read parent.**
   ```sh
   omp-agent --json agent edit "$DOGFOOD_PARENT" "$DOGFOOD_EDIT_DOC"
   omp-agent --json agent show "$DOGFOOD_PARENT"
   ```
   Record `rebuildRequired`. From `agent show` JSON, confirm `definition.schedules[$DOGFOOD_SCHEDULE_INDEX]` contains only the approved authored `{cron, prompt, room?}` entry. Do not expect a runtime ID from `agent show` or author an `id` field.
5. **Create and show child.**
   ```sh
   omp-agent --json agent create "$DOGFOOD_CHILD" "$DOGFOOD_CHILD_DEFINITION"
   omp-agent --json agent show "$DOGFOOD_CHILD"
   ```
6. **Spawn parent.**
   ```sh
   omp-agent --json spawn "$DOGFOOD_PARENT"
   ```
7. **Spawn child under parent and confirm hierarchy.**
   ```sh
   omp-agent --json spawn "$DOGFOOD_CHILD" --parent "$DOGFOOD_PARENT"
   omp-agent --json agents
   ```
   Confirm `agents[]` contains the parent with `children` including `$DOGFOOD_CHILD`, and the child with `parent` equal to `$DOGFOOD_PARENT`.
8. **List, read, post, and re-read room.**
   ```sh
   omp-agent --json rooms
   omp-agent --json rooms read "$DOGFOOD_ROOM"
   omp-agent --json rooms post "$DOGFOOD_ROOM" "dogfood session ${DOGFOOD_SESSION_ID}"
   omp-agent --json rooms read "$DOGFOOD_ROOM"
   ```
9. **List schedules before restart.**
   ```sh
   omp-agent --json schedule
   ```
   Record the returned runtime schedule state. `agent edit` writes the definition; schedule registration occurs at daemon startup.
10. **Read worker and daemon logs.**
    ```sh
    omp-agent --json logs "$DOGFOOD_PARENT" 100
    omp-agent --json logs "$DOGFOOD_CHILD" 100
    omp-agent --json logs daemon 100
    ```
11. **Inject approved steering text.**
    ```sh
    omp-agent --json inject "$DOGFOOD_CHILD" "$DOGFOOD_INJECT_TEXT"
    ```
12. **Apply approved account bump.** Recheck account, approved amount, and finite-number rule immediately before execution.
    ```sh
    omp-agent --json bump "$DOGFOOD_ACCOUNT" "$DOGFOOD_BUMP_USD"
    ```
13. **Kill parent while retaining child.**
    ```sh
    omp-agent --json kill "$DOGFOOD_PARENT" --keep-children
    omp-agent --json agents
    ```
    Confirm parent stopped and child remains without that parent.
14. **Kill retained child.**
    ```sh
    omp-agent --json kill "$DOGFOOD_CHILD"
    omp-agent --json agents
    ```
15. **Recreate hierarchy.**
    ```sh
    omp-agent --json spawn "$DOGFOOD_PARENT"
    omp-agent --json spawn "$DOGFOOD_CHILD" --parent "$DOGFOOD_PARENT"
    omp-agent --json agents
    ```
16. **Exercise default cascade kill.**
    ```sh
    omp-agent --json kill "$DOGFOOD_PARENT"
    omp-agent --json agents
    ```
    Confirm neither parent nor child remains running. Finish §5 observations before restart.
17. **Restart daemon, verify the runtime schedule ID, and exercise schedule controls.**
    ```sh
    omp-agent --json daemon restart
    omp-agent --json status
    omp-agent --json schedule
    omp-agent --json schedule "$DOGFOOD_SCHEDULE_ID" on
    omp-agent --json schedule
    omp-agent --json schedule "$DOGFOOD_SCHEDULE_ID" off
    omp-agent --json schedule
    ```
    After restart, find the `schedules[]` entry whose `id` exactly equals `$DOGFOOD_SCHEDULE_ID`; confirm its `cron` and `action` match the authored entry. After `on`, confirm that same entry has `enabled: true`; after `off`, confirm it has `enabled: false`. `nextFireAt` is also present in each runtime entry.
18. **Stop daemon.**
    ```sh
    omp-agent --json daemon stop
    ```

## 5. Manual console and TUI checks

Begin after §3 and finish after scenario step 16. Record each named result as `pass` or `finding` with evidence.

- [ ] **Manual: console loads.** Record visible definitions before spawn; parent/child names and states after steps 6-7; selected room; posted message ID/body from step 8; UTC observation times. Never record URL token.
- [ ] **Manual: console updates live.** Keep `$DOGFOOD_ROOM` visible during steps 8 and 11. Record message IDs, whether post and any agent response appeared without refresh, observed delay, and missing update.
- [ ] **Manual: TUI transitions.** Observe spawn, parent/child hierarchy, injected work, keep-children result, explicit child kill, and cascade result. Record exact displayed states, hierarchy before/after each kill, UTC times, and mismatches.

## 6. Worker-backend coverage boundary

The shipped CLI starts the default RPC worker backend. Record RPC coverage only from completed spawn/interaction/kill scenario evidence.

The in-process backend is **not selectable through shipped CLI today**. Its operator-facing selector and dogfood coverage arrive with [T-1405](delivery/tasks/T-1405-daemon-backend-selector.md). Do not invent syntax. Do not record in-process as exercised, passed, or skipped-but-successful; omit it from current session success counts and mark coverage `deferred to T-1405` only.

## 7. Incident and timebox stop

On any failed command, failed Manual check, incident, or timebox expiry:

1. Stop issuing scenario, cleanup, schedule, worker, bump, and daemon commands.
2. Preserve `$DOGFOOD_SESSION_LOG` at mode `0600`.
3. Preserve daemon and worker state for evidence; record last successful step, failure, UTC time, and last observed agent/schedule states without changing them.
4. Enter §8 triage. Mark every unrun scenario or Manual check `not run: session stopped` with reason. Never count it as pass.

Do not add an OS-level kill, PID polling, allowlist refusal, bump ceiling, or abort cleanup procedure here. [T-1404](delivery/tasks/T-1404-live-session-safety-rails.md) owns enforced abort and cleanup.

## 8. Triage and closure

Session record must enumerate scenario steps 1-18, three Manual preconditions, three Manual console/TUI checks, and RPC backend evidence. Every entry is `pass`, `finding`, or `not run` with reason. Silence never means pass. In-process coverage is a T-1405 deferral, not a session result.

Every finding receives exactly one disposition before closure:

1. **Generator task:** add task definition to `scripts/gen-delivery-docs.py` with goal, steps, acceptance, dependencies, and relevant redacted log evidence; then run documented generator workflow. Never hand-edit `docs/delivery/`.
2. **Reasoned wont-fix:** record decision, owner, rationale, and exact redacted evidence from `$DOGFOOD_SESSION_LOG`. Label without evidence and reasoning is not a disposition.

Close session only after every entry has a result or explicit stop reason and every finding has one disposition.
