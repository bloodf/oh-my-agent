# oh-my-agent

An [oh-my-pi (OMP)](https://omp.sh/docs) plugin that runs **autonomous, long-lived agents** — they keep working while you're away, talk to each other in persistent chat rooms, and are fully observable and steerable from the OMP TUI.

**Status: pre-release.** The runtime subsystems (workers, isolation, credentials, rooms, scheduling, quota handling) are built and under test; so are the operator surfaces: the daemon binary and control socket, the OMP TUI extension, and the browser console. [`ARCHITECTURE.md`](ARCHITECTURE.md) is the design specification with per-section implementation markers; [`docs/delivery/`](docs/delivery/README.md) is the authoritative task tree. The web console has its own guide: [`docs/web-console.md`](docs/web-console.md).

## Requirements

- Bun ≥ 1.3.14
- [OMP](https://omp.sh) (`@oh-my-pi/pi-coding-agent` ≥ 18.0.7) as a peer

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit, integration, and OMP contract suites
bun run lint        # biome check
bun run docs        # regenerate docs/delivery (edit scripts/gen-delivery-docs.py, never the output)
```

Working rules: test-first with non-vacuity proofs, tests call production builders, and every unit of work is a task file in the delivery tree. See [`docs/delivery/README.md`](docs/delivery/README.md).

## License

[MIT](LICENSE) — see [ADR-010](docs/delivery/adr/ADR-010-mit-license.md) for the decision record.
