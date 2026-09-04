# Setup

Requirements: [Bun](https://bun.sh) >= 1.3.14 and [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` >= 18.0.7). The OMP packages are peer plus dev dependencies; `bun install` is enough for a checkout.

BASE_BRANCH: `main`.

## 1. Clone and install

```sh
git clone https://github.com/bloodf/oh-my-agent.git
cd oh-my-agent
bun install
```

The package has no `dependencies` and no `build` script ([`tests/build-hygiene.test.ts`](../../tests/build-hygiene.test.ts)). Runtime is TypeScript run by Bun from `src/`.

## 2. Optional: headless Chrome

The browser-console suite ([`tests/console-client.test.ts`](../../tests/console-client.test.ts)) drives Chrome. CI installs it; locally, if the suite cannot find a browser:

```sh
bunx @puppeteer/browsers install chrome-headless-shell --path "$HOME/.cache/puppeteer"
```

Skip this if you are not touching the console client. `bun run test:fast` already skips that suite.

## 3. First green run

```sh
bun run typecheck   # tsc --noEmit
bun run test:fast   # full suite minus pack, consumer-install, console-client
bun run lint        # biome check .
```

Before a PR, run the full suite and the docs generator:

```sh
bun test            # timeout 30000; same command CI runs
bun run docs        # python3 scripts/gen-delivery-docs.py
bun run docs        # second run must produce no diff
```

`bun run test:consumer-install` is the pack-and-install smoke alone. CI runs it as part of `bun test` with `node_modules/.bin` on `PATH` so the real `omp` executable is visible.

## 4. Scripts

| Script | Command | When |
|---|---|---|
| `typecheck` | `tsc --noEmit` | Every change |
| `test` | `bun test --timeout 30000` | Before a PR; what CI runs |
| `test:fast` | `bun test` ignoring `tests/pack.test.ts`, `tests/consumer-install.test.ts`, `tests/console-client.test.ts` | Iteration on daemon, worker, rooms, extension |
| `test:consumer-install` | that one file | Packaging / install path |
| `lint` | `biome check .` | Every change |
| `format` | `biome check --write .` | When lint reports format drift |
| `docs` | `python3 scripts/gen-delivery-docs.py` | After editing the generator |

`prepack` runs `typecheck` then `test:fast`. There is no compile step.

## 5. Editor and Biome

[`biome.json`](../../biome.json) is the style source:

- Indent: tabs
- Quotes: double
- Linter: `recommended` preset
- Import organize: on
- VCS: git, respects `.gitignore`

`bun run lint` is `biome check .`. `bun run format` writes. TypeScript is strict ESNext, `noEmit`, `types: ["bun"]` ([`tsconfig.json`](../../tsconfig.json)).

## 6. What CI runs

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) on push to `main` and on pull requests:

1. Changelog version matches `package.json` / `omp.version`
2. Patch hygiene (`python3 scripts/check-patches.py` and `--selftest`)
3. `bun install --frozen-lockfile`
4. Chrome headless shell (same command as step 2)
5. `bun run typecheck`
6. `PATH="$PWD/node_modules/.bin:$PATH" bun test --timeout 30000`
7. `bunx biome check .`
8. `python3 scripts/gen-delivery-docs.py` then `git diff --exit-code docs/`

A stale `docs/delivery/` tree, or a hand-edit of it, fails that last step.

## Patches

[`patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`](../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch) adds `RpcClient.pid`. Bun applies it only from this checkout's root manifest. npm consumers of the published package get the unpatched peer ([ADR-013](../delivery/adr/ADR-013-release-channel.md)). Do not invent a second patch path. Removal is [T-1504](../delivery/tasks/T-1504-drop-rpc-pid-patch.md), blocked on an upstream release.
