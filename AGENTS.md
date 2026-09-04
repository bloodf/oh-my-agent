# oh-my-agent

OMP plugin for autonomous long-lived multi-agent collaboration. A Bun daemon supervises RPC workers, persistent rooms, schedules, and scoped credentials; operators steer them from the OMP TUI, `omp-agent` CLI, or a loopback browser console.

## Conventions

- Bun >= 1.3.14. Run `bun run typecheck`, tests, `bun run lint`, and `bun run docs` before a PR.
- Tests call production builders. Prove non-vacuity: revert the production line, watch the test fail, restore.
- No fixed sleeps. Deadline-bounded polls. Spawn cleanup in `finally`.
- Commits: imperative, ticket in parens when applicable (`feat: ... (T-xxxx)`).
- Never commit tokens. Never log credential material.
- `docs/delivery/` is generated. Author in `scripts/gen-delivery-docs.py`. Never hand-edit the output.
- Isolation: OS sandbox is opt-in and fail-closed; write isolation and convention scoping are weaker. `workspace:` is not a security boundary.
- BASE_BRANCH: `main`

## Repo map

- `src/daemon/` - composition root, socket, supervisor, scheduler, gateway, CLI
- `src/worker/` - RPC lifecycle, sandbox, toolbelt
- `src/rooms/` - SQLite room store
- `src/extension/` - OMP TUI plugin
- `src/console/` - browser client (no build step)
- `src/shared/` - protocol and peer parser
- `tests/` - unit, integration, contract, browser, pack
- `scripts/gen-delivery-docs.py` - delivery tree source

## Pointers

- Contributor hub: [docs/develop/README.md](docs/develop/README.md)
- Design spec: [ARCHITECTURE.md](ARCHITECTURE.md) (delivery tree wins on disagreement)
- Ground rules: [CONTRIBUTING.md](CONTRIBUTING.md)
