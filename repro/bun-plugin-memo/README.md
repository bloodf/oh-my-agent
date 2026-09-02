# A runtime `Bun.plugin` `onResolve` hook changes what `import.meta.resolve` returns

MIT License. Public hosting: <https://github.com/bloodf/oh-my-agent>, in-tree at `repro/bun-plugin-memo/`.

Everything above the Context heading is what this repro measured. The Context
section is sourced from upstream code and from our own tree; it is cited, it is
not evidenced by these counts, and it is kept separate so the issue body cannot
be read as claiming more than it recorded.

## Symptoms

On Bun 1.3.14, installing a runtime `Bun.plugin` hook changes what
`import.meta.resolve` returns for a specifier that resolves normally without
it. Two configurations, ten consecutive resolutions each:

- With `@oh-my-pi/pi-coding-agent` 18.0.7's shim installed, resolving
  `@oh-my-pi/pi-coding-agent/package.json` returns a **4282-character** string
  beginning `file:file:file:file:...` instead of the **134-character**
  `file://` URL the same call returns with no hook installed. 10/10.
- With a hand-written minimal hook and **no OMP package present at all**,
  resolving the hook's own local fixture package throws
  `Maximum call stack size exceeded`. 10/10.

Both configurations register an `onResolve` handler. Why one process ends in a
stack overflow and the other returns a long `file:`-prefixed string is not
established here. What is recorded is the counts and the raw strings behind
them; see [Context](#context) for what upstream's source says about the hook.

The specifier is part of the record rather than an interchangeable detail: the
repro pins `@oh-my-pi/pi-coding-agent/package.json` and reports it in every
line of output, so any other specifier is a different observation and not this
one.

## Observed resolutions

`repro.ts` resolves one specifier — `@oh-my-pi/pi-coding-agent/package.json` —
ten consecutive times per case, in separate child processes, and prints every
raw result with its length. Each case runs in its own process because the repro
needs a process where the hook was never installed and a process where it was.

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

### The `bare` control is OMP-free by construction, and the construction is checked

The `bare` case does not run in this directory. `repro.ts` creates a temp
directory, writes a `package.json`, a single trivial local package
`node_modules/plainpkg`, and a standalone sandbox program into it, then runs
that program with:

- `bun --no-install`, so nothing can be fetched,
- `HOME` and `BUN_INSTALL` pointed inside the sandbox, so no global cache or
  global install directory is consulted,
- every inherited `BUN_*` variable (`BUN_CONFIG` included) and `NODE_OPTIONS`
  explicitly removed from the child environment, so no configuration or
  preload arrives through the environment,
- `cwd` set to the sandbox, so this repo's `node_modules` is not on the
  resolution path.

Those four settings control what the sandbox starts *from*. They say nothing
about what sits *above* it, and Bun walks parent directories for both
`bunfig.toml` and `node_modules` — so a temp directory created underneath a
checkout, or under a `TMPDIR` pointed at one, would silently inherit both.

So the isolation is audited rather than asserted. Before the first sandbox
spawn, `repro.ts` resolves the sandbox's real path and walks from its parent to
the filesystem root, refusing the case on the first ancestor that holds a
`bunfig.toml`, a `.bunfig.toml`, or a `node_modules`. The sandbox itself is
excluded from the walk — it owns a `node_modules` by design, that being the
fixture under test. A clean walk prints:

```
[bare] ancestry audited to the filesystem root: no bunfig.toml variant, no node_modules above the sandbox
```

A refusal prints the offending path and the case does not run. That is the same
path as any other control that could not be established: no counts are
recorded, no filing target is reported, and the run exits 3 rather than
pretending the control returned something.

The sandbox program imports nothing and resolves only `plainpkg/package.json`.
It runs twice: once with no hook, to establish that directory's own plugin-free
baseline, and once with the hook installed.

### What the run reports at the end

The last two lines are a control verdict and a filing line:

```
bare control: decisive (oven-sh/bun) | ran, but its counts decide nothing | did not run
file against: <target>              | file against: deferred — <reason>
```

The control verdict distinguishes a control that **ran with counts that decide
nothing** from one that **could not run at all** — different failures, so they
are not collapsed into one word.

- `bare` throws 10/10, **or** differs 10/10 with 0 throws — with no OMP package
  on disk and no OMP code in the process, the hook changed what the same call
  returns without it → decisive, **oven-sh/bun**.
- `bare` differs 0/10 with 0 throws — the hand-written hook did not change it →
  decisive, **oh-my-pi**.
- a mixed count — the control ran, and its counts decide no tracker.
- a refused ancestry, a sandbox that could not resolve its own fixture, or a
  non-zero sandbox exit — the control did not run.

`file against: <target>` is printed **only** when the failure reproduced and
the control was decisive. In every other case the line reads `file against:
deferred — <reason>`, so stdout never carries a tracker recommendation for a
run that did not earn one.

**Recorded outcome: `bare` throws 10/10 → decisive, oven-sh/bun.**

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
in the record rather than a summary of them. The `Bun.version` reading and the
version refusal beneath it both go to stderr, so the version gate is not split
across two streams.

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
`import.meta.resolve` returns for a specifier that already resolves. All three
cases print the same string as their plugin-free baseline and report
`differs=0/10 threw=0/10`.

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

Exit codes:

| Code | Meaning | Filing line |
|---|---|---|
| `0` | reproduced, and the `bare` control was decisive | `file against: <target>` |
| `1` | ran cleanly, the reported failure did not appear | `file against: deferred — the reported failure did not reproduce in this run` |
| `2` | could not run: wrong Bun, or the plugin-free baseline itself threw | not printed; the run stops before the summary |
| `3` | reproduced, but the `bare` control was not decisive — it either ran with a mixed count or could not run at all | `file against: deferred — <which of the two>` |

A green run cannot hide a non-reproduction, and a non-zero run never prints a
tracker recommendation.

## Context

None of this section is measured by the counts above. It is read off upstream
source and our own tree, cited so it can be checked, and separated so the issue
body stays at what was recorded.

**The hook.** In `@oh-my-pi/pi-coding-agent` 18.0.7 the shim is installed by
`installLegacyPiSpecifierShim()` at
`src/extensibility/plugins/legacy-pi-compat.ts:2867-2891`. It registers
`onResolve` for the `@(scope)/pi-*` filter, and its handler resolves that same
specifier (`getResolvedSpecifier`, ~1127-1135). Importing
`src/extensibility/plugins/loader.ts` or
`src/extensibility/extensions/loader.ts` installs it as a bare import side
effect (`loader.ts:21`, `loader.ts:55`). Reading that source, a handler that
resolves the specifier it matched is re-entered by its own resolution — an
inference from the code, not a measurement here.

**Hook lifetime.** `Bun.plugin` registers process-globally and nothing in the
upstream source uninstalls it, so any code that imports the installing module
carries the behavior for the rest of the process. This is why each case in the
repro runs in its own child process.

**Our workaround.** We do not resolve the specifier at all: we walk
`node_modules` ancestors from `import.meta.dir` until the file exists —
[`src/worker/lifecycle.ts:107-142`](https://github.com/bloodf/oh-my-agent/blob/main/src/worker/lifecycle.ts)
(`resolveOmpCli`) — since a filesystem walk is unaffected by any resolver hook.

**A falsified theory.** An earlier "the plugin memoizes one package's path and
hands it to another" theory is falsified by upstream's cache key, which is the
exact specifier string (`legacy-pi-compat.ts`, `getResolvedSpecifier`,
~1127-1135), so it cannot carry a path across specifiers. This is read off the
installed source; the repro measures nothing about it.
