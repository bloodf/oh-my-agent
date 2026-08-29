# EP-11 — Operator polish: AAA console and the CLI surface

**Status:** Ready

*Derived from the tasks below.*

## Outcome

The web console looks and behaves like a product — a coherent visual system, keyboard-complete operation, and accessibility that survives a screen reader — and every daemon operation is reachable from shell commands with no TUI at all.

## Why this is its own epic

The console was built for correctness; it has one ARIA attribute and no visual system. The plugin is equally operable only inside the OMP TUI today, which makes the daemon unusable in scripts and plain terminals.

## In scope

- A dependency-free design system for the console: tokens, dark theme, layout, message and state rendering.
- AAA accessibility: landmarks, live regions, focus management, full keyboard operation, contrast, reduced motion.
- A management CLI on the omp-agent binary: every daemon verb with clean errors and script-friendly output.

## Not in scope

- A build step or a framework; the console stays dependency-free by decision (T-603).
- Touching the daemon protocol for the CLI's sake; it consumes the frozen 20 methods.

## Acceptance

- [ ] Every daemon operation is scriptable via `omp-agent <verb>` with non-zero exits on failure and a `--json` mode.
- [ ] The console passes the browser suite's accessibility assertions: landmarks, keyboard flows, focus order, contrast.
- [ ] The visual overhaul ships as one design system (tokens), not a restyle per component.

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1101](../tasks/T-1101-console-visual-system.md) | Console visual system and usability overhaul | Done |
| [T-1102](../tasks/T-1102-console-accessibility.md) | Console accessibility to AAA standard | Ready |
| [T-1103](../tasks/T-1103-cli-management-surface.md) | CLI management verbs: no TUI required | Done |
