# FAQ

Short answers to mistakes the parser, CLI, and install path actually produce. Related: [Agents](agents.md), [CLI](cli.md), [Security](security.md).

## `agent create` refused my `tools:` (or `workspace:`, `sandbox:`, `skills:`, `schedules:`)

`omp-agent agent create` sends only `{ name, description, model, rooms, wake, autonomy, spawns, body }`. Extra keys in the document are refused, not dropped. That is deliberate: reporting success for a peer that is missing fields you authored would be a silent lie.

Remove the extra keys, create, then set them with `agent edit` and a JSON changes object:

```sh
echo '{"tools":["read","grep","chat_send","chat_read"]}' | omp-agent agent edit researcher -
```

The shipped examples omit `tools:` for this reason. See [Agents](agents.md).

## `model: "@task"` (or another `@role`) will not spawn

Native OMP task agents accept `@role` aliases via `modelRoles`. Materialized **peers** do not. `resolveWorkerModel` requires a literal `provider/id` so the credential gateway can route the worker.

Use:

```yaml
model: "anthropic/claude-sonnet-4-5"
```

not:

```yaml
model: "@task"
```

Create may store an unqualified selector. Spawn then fails at materialize time.

## I set `workspace:` and the agent still read files outside it

Expected. `workspace:` is `cwd` and project discovery. It is not a security boundary. Only `sandbox: true` (RPC workers, macOS Seatbelt or Linux `bwrap`) is a real filesystem fence, and it is opt-in. In-process workers are never sandboxed. See [Security](security.md).

## npm install has no `RpcClient.pid` / supervision looks degraded

By design until upstream lands the accessor ([ADR-013](../delivery/adr/ADR-013-release-channel.md)).

Bun honors `patchedDependencies` only from the **consumer's** root manifest. `@oh-my-pi/pi-coding-agent` reaches you as a peerDependency, so the repo patch cannot travel with the published package. npm 12 also strips the patch file from the tarball. `bun install` in this checkout applies the patch; npm consumers get an unpatched peer.

The consumer-install smoke asserts this degraded state on purpose (`EXPECTED_RPC_CLIENT_PID = "absent"`). Release notes name it. Do not assume pid-based supervision works on an npm install.

## Every command says the daemon is not running

Exact sentence, exit code 3:

```
oh-my-agent daemon not running — start it with `omp-agent daemon`.
```

Start it. Closing the OMP TUI does not start the daemon. `omp-agent` with no arguments does (it is an alias of `omp-agent daemon`). `omp-agent daemon stop` stops it. Closing the terminal does not.

Socket path: `<agent-dir>/oh-my-agent/daemon.sock`. A different `PI_CODING_AGENT_DIR` is a different daemon.

## I put the peer in `~/.omp/agent/agents/` and OMP's `/agents` is now polluted

That root is global to every OMP session. Peer definitions belong in:

- `~/.omp/agent/oh-my-agent/agents/*.md`
- `<project>/.omp/oh-my-agent/agents/*.md`

`agent create` writes the project path. Native task agents (temporary `task` subagents) stay in the OMP roots.

## `Unknown key: "room"` / `"parent"` / `"wake.mentions"`

The parser throws on any key it does not know.

- The list is `rooms`, an array, with `#` or `@` prefixes
- `parent` is `omp-agent spawn name --parent other`, never frontmatter
- Wake keys are `mention` and `rooms`, both boolean. Not `mentions`

## `MISSING_SPAWNS`

Peers require `spawns:`. Native task agents do not. Use `spawns: "*"` if this peer should be allowed to dispatch any in-run subagent, or list names.

## Spawn failed because `agent_spawn` had no rooms

The worker toolbelt rejects `agent_spawn` without a non-empty `rooms` array, including persistent children. Operator `omp-agent spawn` uses the definition's `rooms:`. A coding subtask should use native `task`, not `agent_spawn`.

## `bump` refused 0

Ceilings must be strictly positive. Zero makes `burned / ceiling` infinite and parks an account that has spent nothing. Negative would disable parking. Use a positive USD amount. The account id is the provider key (`anthropic`, not the full model id).

## How do I report a security issue?

Do not open a public GitHub issue. Use [private reporting](https://github.com/bloodf/oh-my-agent/security/advisories/new). See [Security](security.md) and [SECURITY.md](../../SECURITY.md).

## Where is the rest of the docs?

[Documentation hub](../README.md).
