# Dogfooding runbook

Newcomers start at [Getting started](guide/getting-started.md) before this live-account session.
This page is the operator procedure for one dogfood run.
Pictures live in [diagrams](diagrams/).

Human operator procedure for one live-account dogfood session. [T-1402](delivery/tasks/T-1402-dogfood-harness.md) automates the numbered JSON scenario in §4. Console URL retrieval and console/TUI observations remain outside that mapping; the scenario covers both worker backends.

**This session touches real accounts and can spend real money.** Complete every approval and preflight check before starting.

## 0. Source-verified scope

- [`README.md`](../README.md) describes the project, requirements, and checkout development commands. It does **not** document daemon environment controls or a released-artifact install path. Installation belongs to [T-1304](delivery/tasks/T-1304-install-docs.md).
- [`src/daemon/main.ts`](../src/daemon/main.ts) honors `PI_CODING_AGENT_DIR`, disables the console when `OMA_CONSOLE=0`, and accepts a decimal `OMA_CONSOLE_PORT` from `0` through `65535`. These are the controls this runbook uses, not an exhaustive list of daemon environment variables.
- [`src/daemon/cli.ts`](../src/daemon/cli.ts) exposes `daemon --worker-backend rpc|in-process`; RPC remains the default when the selector is omitted, and `--json` reports the selected backend as `workerBackend` in the launcher envelope.
- `src/daemon/cli.ts` defines all command forms used below. `--json` precedes each JSON-capable verb. `omp-agent console` returns a plain-text URL and remains a manual precondition; daemon start, stop, and restart are JSON-capable.

## 1. Operator-approved variables

Fill every value. Values are operator inputs, never defaults. Quote values containing spaces. Never place credentials or console tokens in these variables.

```sh
export DOGFOOD_ACCOUNT='<approved-account-id>'
export DOGFOOD_ACCOUNT_ALLOWLIST='<approved-account-id,other-approved-account-id>'
export DOGFOOD_PARENT='<approved-parent-name>'
export DOGFOOD_CHILD='<approved-child-name>'
export DOGFOOD_PARENT_DEFINITION='<approved-parent-definition-md-path>'
export DOGFOOD_CHILD_DEFINITION='<approved-child-definition-md-path>'
export DOGFOOD_EDIT_DOC='<approved-definition-update-json-path>'
export DOGFOOD_SCHEDULE_INDEX='<approved-zero-based-schedule-index>'
export DOGFOOD_SCHEDULE_ID="${DOGFOOD_PARENT}:schedule:${DOGFOOD_SCHEDULE_INDEX}"
export DOGFOOD_BUMP_USD='<approved-bump-usd>'
export DOGFOOD_MAX_BUMP_USD='<approved-maximum-bump-usd>'
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
- [ ] **Account allowlist approved.** Budget owner approved every comma-separated account in `$DOGFOOD_ACCOUNT_ALLOWLIST`, and exact `$DOGFOOD_ACCOUNT` appears in it. The harness refuses an empty allowlist or non-member account before issuing any CLI verb.
- [ ] **Inputs approved.** Owner approved names, both Markdown definitions, edit JSON, room, schedule entry index, derived schedule ID, and steering text.
- [ ] **Bump approved and bounded.** Budget owner approved exact `$DOGFOOD_BUMP_USD` and `$DOGFOOD_MAX_BUMP_USD`. Both must be finite and non-negative, and harness refuses a bump above maximum before issuing any CLI verb.
- [ ] **Timebox approved.** Record `$DOGFOOD_TIMEBOX_MINUTES` and wall-clock stop time. Reaching either stops new scenario work and enters §7.
- [ ] **Paths validated.** `PI_CODING_AGENT_DIR` selects intended profile; both Markdown definitions and edit JSON exist and are readable; edit document is a JSON object.
- [ ] **Room validated.** `$DOGFOOD_ROOM` starts with `#` or `@`.

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

These actions prepare the live surfaces. The RPC daemon start supplies the first backend leg before T-1402's 1:1 scenario mapping; record its JSON envelope and require `workerBackend: "rpc"`.

1. **Manual: RPC daemon start.** Start selected profile through the explicit selector:
   ```sh
   omp-agent --json daemon --worker-backend rpc
   ```
   Require exit status `0` and `workerBackend: "rpc"`. Record elapsed time and the redacted envelope; never record token material.
2. **Manual: console URL.** Retrieve URL:
   ```sh
   omp-agent console
   ```
   Do not log raw output. Open unredacted URL in operator browser. Record only load result and UTC time.
3. **Manual: TUI ready.** Open shipped OMP TUI against same `PI_CODING_AGENT_DIR`. Record profile identity and initial visible state. Do not invent a command for an installation-specific TUI launcher.

## 4. JSON-capable management scenario

This section maps 1:1 to T-1402 after §3 starts the RPC leg. Run in order. Every command uses a JSON-capable form from `src/daemon/cli.ts`. Any failure stops progression and enters §7; no backend leg may be skipped and counted as success.

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
12. **Apply approved account bump.** Recheck account, approved amount, and finite non-negative bump rule immediately before execution.
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
18. **Switch to and exercise the in-process backend.**
    ```sh
    omp-agent --json daemon stop
    omp-agent --json daemon --worker-backend in-process
    omp-agent --json spawn "$DOGFOOD_PARENT"
    omp-agent --json spawn "$DOGFOOD_CHILD" --parent "$DOGFOOD_PARENT"
    omp-agent --json inject "$DOGFOOD_CHILD" "$DOGFOOD_INJECT_TEXT"
    omp-agent --json kill "$DOGFOOD_PARENT"
    ```
    Require the launcher envelope to report `workerBackend: "in-process"`. Poll and confirm the parent/child hierarchy reaches running before injection, then confirm the cascade kill leaves neither running. Any failed command, mismatched selector report, or failed state check fails the session; never record this leg as skipped-success.
19. **Enter unconditional cleanup.** Harness leaves scenario work and, in its `finally` cleanup, cascade-kills every agent it attempted to spawn, disarms every schedule it may have armed, then stops daemon. Cleanup continues through individual command failures; earlier scenario failure remains reported error.

## 5. Manual console and TUI checks

Begin after §3 and finish after scenario step 16. Record each named result as `pass` or `finding` with evidence.

- [ ] **Manual: console loads.** Record visible definitions before spawn; parent/child names and states after steps 6-7; selected room; posted message ID/body from step 8; UTC observation times. Never record URL token.
- [ ] **Manual: console updates live.** Keep `$DOGFOOD_ROOM` visible during steps 8 and 11. Record message IDs, whether post and any agent response appeared without refresh, observed delay, and missing update.
- [ ] **Manual: TUI transitions.** Observe spawn, parent/child hierarchy, injected work, keep-children result, explicit child kill, and cascade result. Record exact displayed states, hierarchy before/after each kill, UTC times, and mismatches.

## 6. Worker-backend coverage

The §3 explicit RPC selector plus §4 steps 1-17 form the RPC leg. Require its daemon launcher envelope to report `workerBackend: "rpc"`.

Step 18 stops that daemon, starts `omp-agent --json daemon --worker-backend in-process`, consumes the launcher envelope, and requires `workerBackend: "in-process"` before driving spawn, hierarchy, injection, and cascade kill. Both completed legs are required for session success; a missing or failed leg is `finding` or `not run: session stopped`, never skipped-but-successful.

## 7. Incident, timebox stop, and OS abort

On any failed command, failed Manual check, incident, or timebox expiry, stop issuing new scenario work. Harness automatically enters its `finally` cleanup while daemon remains reachable: cascade-kill tracked workers, disarm tracked schedules, then stop daemon. Preserve `$DOGFOOD_SESSION_LOG` at mode `0600`; record last successful step, failure, UTC time, cleanup results, and last observed agent/schedule states. Enter §8 triage and mark every unrun scenario or Manual check `not run: session stopped` with reason.

If harness hangs or CLI cleanup cannot reach daemon, use this OS-level fallback. Do not use `omp-agent daemon stop` in this fallback. Capture every current daemon descendant before killing daemon, send daemon `SIGTERM`, wait at most 10 seconds for captured workers to die, then send `SIGKILL` to surviving workers and daemon:

```sh
DAEMON_PID_FILE="$PI_CODING_AGENT_DIR/oh-my-agent/daemon.pid"
DAEMON_PID="$(cat -- "$DAEMON_PID_FILE")"
case "$DAEMON_PID" in (*[!0-9]*|'') printf '%s\n' "invalid daemon pid: $DAEMON_PID" >&2; exit 1;; esac
case "$DAEMON_PID" in (*[!0]*) :;; (*) printf '%s\n' "invalid daemon pid: $DAEMON_PID" >&2; exit 1;; esac
WORKER_PIDS=""
FRONTIER="$DAEMON_PID"
while [ -n "$FRONTIER" ]; do
  NEXT=""
  for parent_pid in $FRONTIER; do
    for pid in $(pgrep -P "$parent_pid" || true); do
      WORKER_PIDS="$WORKER_PIDS $pid"
      NEXT="$NEXT $pid"
    done
  done
  FRONTIER="$NEXT"
done
kill -TERM "$DAEMON_PID"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  ALIVE_WORKER_PIDS=""
  for pid in $WORKER_PIDS; do [ -n "$(ps -p "$pid" -o pid= 2>/dev/null)" ] && ALIVE_WORKER_PIDS="$ALIVE_WORKER_PIDS $pid"; done
  [ -z "$ALIVE_WORKER_PIDS" ] && break
  sleep 1
done
for pid in $ALIVE_WORKER_PIDS; do kill -KILL "$pid" 2>/dev/null || true; done
kill -KILL "$DAEMON_PID" 2>/dev/null || true
for pid in $WORKER_PIDS; do
  if [ -n "$(ps -p "$pid" -o pid= 2>/dev/null)" ]; then printf '%s\n' "worker still alive: $pid" >&2; exit 1; fi
done
```

Record daemon PID, recursively captured worker PIDs, signals sent, bounded-wait result, and any survivor without recording credentials or tokens. OS abort cannot call schedule controls, so record every previously armed schedule as requiring verification before later daemon start. On next start, run `omp-agent --json schedule`, disarm any enabled dogfood schedule, and refuse further scenario work until none remain armed.

## 8. Triage and closure

Session record must enumerate scenario steps 1-19, three Manual preconditions, three Manual console/TUI checks, and separate RPC and in-process backend evidence. Every entry is `pass`, `finding`, or `not run` with reason. Silence never means pass; neither backend may be skipped and counted as success.

Every finding receives exactly one disposition before closure:

1. **Generator task:** add task definition to `scripts/gen-delivery-docs.py` with goal, steps, acceptance, dependencies, and relevant redacted log evidence; then run documented generator workflow. Never hand-edit `docs/delivery/`.
2. **Reasoned wont-fix:** record decision, owner, rationale, and exact redacted evidence from `$DOGFOOD_SESSION_LOG`. Label without evidence and reasoning is not a disposition.

Close session only after every entry has a result or explicit stop reason and every finding has one disposition.
