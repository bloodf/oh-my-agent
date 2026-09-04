# Testing

Every change carries evidence that it works. A green suite is not evidence if the test would stay green without the fix.

## How to run

```sh
bun test                 # full suite, --timeout 30000 (CI)
bun run test:fast        # skips pack, consumer-install, console-client
bun run test:consumer-install
bun test tests/rooms.test.ts
```

`test:fast` is the iteration default when the change is not packaging or the browser console.

Browser-console tests need Chrome. If they cannot find one:

```sh
bunx @puppeteer/browsers install chrome-headless-shell --path "$HOME/.cache/puppeteer"
```

Consumer-install drives the real `omp` binary. CI puts `node_modules/.bin` on `PATH`; locally, `bun install` already put it there if you run through `bun test`.

## Which suite

Pick the file that already covers the module. [modules.md](modules.md) maps each test file. Short guide:

| You changed | Run first |
|---|---|
| Peer parser | `tests/agent-definition.test.ts` |
| Control protocol types / validation | `tests/protocol.contract.test.ts` |
| Daemon boot, socket, composition | `tests/daemon-main.test.ts`, `tests/daemon-boot.test.ts` |
| CLI verbs | `tests/daemon-cli.test.ts` |
| Hierarchy, spawn parentage, kill cascade | `tests/daemon-hierarchy.test.ts` |
| Rooms, threads, reactions | `tests/rooms.test.ts` |
| Supervisor wake / park / staleness | `tests/supervisor.test.ts` |
| Worker RPC lifecycle, env, sandbox launch | `tests/worker-lifecycle.test.ts` |
| In-process worker backend | `tests/worker-inprocess.test.ts` |
| Toolbelt | `tests/toolbelt.test.ts` |
| Materialized worker dirs | `tests/materializer.test.ts` |
| Credential gateway | `tests/credential-gateway.test.ts`, `tests/gateway-client.test.ts` |
| TUI extension | `tests/extension.test.ts` |
| Console HTTP/WS API | `tests/console-api.test.ts` |
| Browser client | `tests/console-client.test.ts` |
| Remote mode / proxy headers | `tests/remote-exposure.test.ts`, `tests/socket-identity.test.ts` |
| npm pack allowlist | `tests/pack.test.ts` |
| Install from tarball | `tests/consumer-install.test.ts` |
| OMP discovery / broker / spawn policy | `tests/contracts/` |

Then run `bun run test:fast` (or `bun test` if you touched a skipped suite). Cross-component behavior that unit tests cannot see belongs in `tests/end-to-end.test.ts`.

Contract suites pin **OMP**, not oh-my-agent. A failure there is often an upstream change, not a local regression.

## How to write

1. **Fail first.** Write the test, watch it fail, then implement.
2. **Call production builders.** Import the function production uses. Do not rebuild a parallel copy of a policy, socket client, or sandbox plan ([ADR-008](../delivery/adr/ADR-008-tests-share-production-builders.md)). The authenticated socket helper is [`tests/fixtures/control-client.ts`](../../tests/fixtures/control-client.ts). Hermetic child env is [`tests/fixtures/hermetic-env.ts`](../../tests/fixtures/hermetic-env.ts).
3. **Prove non-vacuity.** After the test is green, revert the specific production line it covers, confirm **that** test fails, restore the line. Mention the proof in the PR. A test that asserts something already true is worse than no test: it looks like coverage.
4. **No fixed sleeps.** Wait on observable state with a deadline-bounded poll. `sleep(200)` that passes on a laptop and fails on a loaded CI runner is a flake you handed everyone else.
5. **Spawn cleanup in `finally`.** Processes, temp dirs, servers, brokers. Including on timeout. [`tests/fixtures/temp-agent-dir.ts`](../../tests/fixtures/temp-agent-dir.ts) already does this for agent dirs.
6. **Deterministic and isolated.** Safe in the full suite in any order. Prefer injected clocks, `pollOnce` handles, and fake brokers over wall time and the user's real `~/.omp`.

## Flake rules

- Timing: poll with a deadline, never a fixed sleep. `tests/worker-inprocess.test.ts` has a "timer hygiene" group that exists because this bit us.
- Network: bind `127.0.0.1:0`. Do not assume port 8765 (`startAuthBroker`'s default).
- Chrome: console-client is slow and skipped by `test:fast` for a reason. Do not add more browser tests unless the assertion cannot be made against the HTTP API.
- Live accounts: `tests/dogfood.test.ts` drives the harness against a fixture daemon. Real-account evidence is [T-1403](../delivery/tasks/T-1403-first-live-session.md), not a CI suite.

## Hygiene the suite already enforces

[`tests/build-hygiene.test.ts`](../../tests/build-hygiene.test.ts) refuses a `scripts.build` entry and any `dependencies` in `package.json`. Do not add a compile step or a runtime dependency to "make tests easier."

## Evidence in the PR

State the gates you ran, the non-vacuity proof for any new test, and anything you could not verify. "I could not test the tailnet path because I have no tailnet" is a useful sentence. A silent gap is not.
