# EP-15 — Upstream pi-coding-agent hygiene

**Status:** Ready

*Derived from the tasks below.*

## Outcome

The two workarounds — the node_modules walk in resolveOmpCli and the patchedDependencies entry — are each backed by a filed upstream issue with a minimal repro, and both are removable.

## Why this is its own epic

Workarounds without a filed upstream cause drift into load-bearing code. The Bun.plugin memo-corruption walk and the RpcClient.pid patch were both diagnosed to root cause; leaving them unfiled means a future upgrade silently breaks the workaround or the patch, and nobody knows which side moved.

## In scope

- Minimal repros for the legacy-pi-compat memo-corruption and the RpcClient.pid accessor, filed upstream.
- A removal task so the workarounds die with their upstream fixes.

## Not in scope

- Maintaining a fork; the patch exists to be deleted.

## Acceptance

- [ ] Both issues are filed with a minimal repro; links are recorded in the tree.
- [ ] The removal task names the exact code that goes away when each fix lands.

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1501](../tasks/T-1501-repro-import-meta-resolve.md) | Minimal repro: Bun.plugin memo-corruption of import.meta.resolve | Ready |
| [T-1502](../tasks/T-1502-file-upstream-issues.md) | File both pi-coding-agent issues | Blocked |
| [T-1503](../tasks/T-1503-drop-workarounds.md) | Remove the walk and the patch once upstream ships | Planned |
