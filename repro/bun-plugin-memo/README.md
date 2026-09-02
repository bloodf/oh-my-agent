# A runtime `Bun.plugin` `onResolve` handler re-enters itself and breaks `import.meta.resolve`

MIT License. Public hosting: <https://github.com/bloodf/oh-my-agent>, in-tree at `repro/bun-plugin-memo/`.

## Symptoms

Once a process-global `Bun.plugin` runtime hook is installed whose `onResolve`
handler resolves the specifier it just matched, `import.meta.resolve` stops
returning what the same call returns in a process with no hook installed.

Observed on Bun 1.3.14 in two forms:

- With `@oh-my-pi/pi-coding-agent` 18.0.7's shim installed, resolving
  `@oh-my-pi/pi-coding-agent/package.json` returns a **4282-character** string
  beginning `file:file:file:file:...` instead of the normal **134-character**
  `file://` URL. Stable across repeats.
- With a hand-written minimal hook and **no OMP package present at all**,
  resolving the hook's own local fixture package throws
  `Maximum call stack size exceeded`. Stable across repeats.

Both configurations install an `onResolve` handler that resolves the specifier
it just matched. What the recorded output establishes is that such a handler
is re-entered by its own resolution; the two outcomes above are what each
configuration prints. Why one process ends in a stack overflow and the other
returns a long `file:`-prefixed string is not established here, and no
mechanism beyond re-entrant `onResolve` dispatch is asserted.

Downstream consumers of the returned string — `new URL()`, `Bun.spawn`, a
child `import` — then fail. The behavior was first hit in production, where a
spawned child process died with `Module not found`. Our workaround is to not
resolve the specifier at all: walk `node_modules` ancestors from
`import.meta.dir` until the file exists —
[`src/worker/lifecycle.ts`](https://github.com/bloodf/oh-my-agent/blob/main/src/worker/lifecycle.ts)
(`resolveOmpCli`, ~107-142) — since a filesystem walk is unaffected by any
resolver hook.

The hook is process-global and permanent; nothing uninstalls it. Any code that
imports the installing module inherits the behavior for the rest of the
process, including code that never asked for the plugin.

In `@oh-my-pi/pi-coding-agent` 18.0.7 the hook is installed by
`installLegacyPiSpecifierShim()`
(`src/extensibility/plugins/legacy-pi-compat.ts:2867-2891`). It registers
`onResolve` for the `@(scope)/pi-*` filter, and its handler resolves that same
specifier (`getResolvedSpecifier`, `~1127-1135`). Importing
`src/extensibility/plugins/loader.ts` or
`src/extensibility/extensions/loader.ts` installs it as a bare import side
effect (`loader.ts:21`, `loader.ts:55`).

An earlier "the plugin memoizes one package's path and hands it to another"
theory is **falsified**: upstream's cache is keyed by the exact specifier
string, so it cannot carry a path across specifiers.

**Corruption is specifier-dependent, not universal.** With the same shim
installed, `@oh-my-pi/pi-coding-agent/extensibility/skills` — which matches the
same `@(scope)/pi-*` filter — resolves normally at 149 characters. So the
repro records the specifier as part of the observation rather than treating it
as an interchangeable detail.

## Observed resolutions

`repro.ts` resolves one specifier — `@oh-my-pi/pi-coding-agent/package.json` —
ten consecutive times per case, in separate child processes, and prints every
raw result with its length. Separate processes are required because a
`Bun.plugin` hook cannot be removed once installed.

Correct and corrupted are decided by difference, not by any validity rule the
repro invents. The parent process installs no hook, so its own resolution is
the baseline; each case compares its raw results to that exact string. Two
counts are reported per case: `differs` (results not byte-identical to the
baseline) and `threw` (resolutions that raised). A throw is not evidence that a
resolution returned a different string, so it is never scored as a byte
difference.

| Case | Configuration | Recorded (Bun 1.3.14) |
|---|---|---|
| `installed` | upstream shim activated via `installLegacyPiSpecifierShim()` | `differs=10/10 threw=0/10` — 4282-char `file:file:file:...` string |
| `removed` | identical resolutions, no plugin installed (control) | `differs=0/10 threw=0/10` — normal 134-char `file://` URL |
| `bare` | hand-written minimal `Bun.plugin` `onResolve` hook, **no OMP package on disk, no OMP code in the process** | `threw=10/10` — `Maximum call stack size exceeded` |

The `installed` and `removed` rows are the pair that matters: the only
difference between them is whether the hook exists in the process. The repro
treats the failure as reproduced only when `installed` differs 10/10 with 0
throws and `removed` differs 0/10 with 0 throws; it exits non-zero otherwise.

### The `bare` control is OMP-free by construction

The `bare` case does not run in this directory. `repro.ts` creates a temp
directory, writes a `package.json`, a single trivial local package
`node_modules/plainpkg`, and a standalone sandbox program into it, then runs
that program with:

- `bun --no-install`, so nothing can be fetched,
- `HOME` and `BUN_INSTALL` pointed inside the sandbox, so no global cache or
  global install directory is consulted,
- `cwd` set to the sandbox, so this repo's `node_modules` is not on the
  resolution path.

The sandbox program imports nothing and resolves only
`plainpkg/package.json`. It runs twice: once with no hook, to establish that
directory's own plugin-free baseline, and once with the hook installed. So
"no OMP in the process" is a property of the filesystem the control runs in,
not a promise made in a comment.

The `bare` row decides where the issue is filed, and the repro prints the
verdict as its last line, `file against: <target>`:

- `bare` throws 10/10, **or** differs 10/10 with 0 throws — with no OMP package
  on disk and no OMP code in the process, the hook changed what the same call
  returns without it → **oven-sh/bun**.
- `bare` differs 0/10 with 0 throws — the hand-written hook did not change it →
  **oh-my-pi**.
- anything else — a mixed count, or a control that could not be established →
  **inconclusive**. Ambiguous evidence is filed against neither tracker; read
  the raw `bare` lines first.

**Recorded outcome: `bare` throws 10/10 → oven-sh/bun.**

If the plugin-free baseline resolution itself throws, there is nothing to
compare against: the repro says so and exits 2 without running a case.

Each case prints the baseline it was given, then one line per resolution:

```
[<case>] specifier <specifier>
[<case>] baseline len=<n> <raw baseline string>
[<case>] <i>/10 same-as-baseline|differs len=<n> <raw resolved string>
[<case>] <i>/10 threw <raw error message>
[<case>] RESULT differs=<n>/10 threw=<n>/10
```

All resolutions are printed verbatim with their lengths, so the raw strings are
in the record rather than a summary of them.

## Affected versions

- Bun **1.3.14** exactly. `repro.ts` prints `Bun.version` and exits non-zero
  before installing any hook on any other version; the sandbox program gates
  itself the same way.
- `@oh-my-pi/pi-coding-agent` **18.0.7**, pinned exactly in `package.json`;
  `bun.lock` pins the resulting dependency resolution. The `bare` case depends
  on neither.
- `packageManager: "bun@1.3.14"` in `package.json` is expected-runtime
  metadata. Neither it nor `bun.lock` selects or pins the Bun executable —
  install the runtime with the exact-version command below.

## Expected vs actual

**Expected** — installing a runtime plugin does not change what
`import.meta.resolve` returns for a specifier that already resolves, and an
`onResolve` handler that resolves a specifier is not re-entered by its own
resolution. All three cases print the same string as their plugin-free baseline
and report `differs=0/10 threw=0/10`.

**Actual** —

```
installed: differs 10/10 threw 0/10
removed:   differs 0/10  threw 0/10
bare:      threw 10/10   (Maximum call stack size exceeded)
```

With the shim installed, `@oh-my-pi/pi-coding-agent/package.json` resolves to a
4282-character string beginning `file:file:file:file:...`; with the shim absent
the identical call returns the normal 134-character `file://` URL. In the
OMP-free sandbox, the hand-written hook makes `import.meta.resolve` throw
`Maximum call stack size exceeded` on every attempt.

## Repro command

Install Bun 1.3.14 with the official exact-version installer, then run the
repro from a copy of this directory. It has no dependency on the parent
repository, a root `node_modules`, a daemon, environment secrets, or any
unpublished file:

```sh
curl -fsSL https://bun.com/install | bash -s "bun-v1.3.14"
cp -R repro/bun-plugin-memo /tmp/bun-plugin-memo
cd /tmp/bun-plugin-memo
bun install --frozen-lockfile
bun run repro
```

Exit codes: `0` reproduced with a decided filing target, `1` ran cleanly but
the reported failure did not appear, `2` could not run (wrong Bun, or the
plugin-free baseline itself threw), `3` reproduced but the `bare` control was
inconclusive. A green run cannot hide a non-reproduction.
