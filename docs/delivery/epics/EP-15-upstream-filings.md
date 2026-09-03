# EP-15 — Upstream pi-coding-agent hygiene

**Status:** Blocked

*Derived from the tasks below.*

## Outcome

The two workarounds — the node_modules walk in resolveOmpCli and the patchedDependencies entry — are each backed by a filed upstream issue with a minimal repro, and both are removable.

## Why this is its own epic

Workarounds without a filed upstream cause drift into load-bearing code. The Bun.plugin resolution walk and the RpcClient.pid patch both exist because something upstream misbehaves or is missing; leaving them unfiled means a future upgrade silently breaks the workaround or the patch, and nobody knows which side moved. The pid filing is also distribution-blocking: per ADR-013, npm consumers get an unpatched RpcClient until it lands, so EP-13's release gate can only assert the degraded state until this epic moves.

## In scope

- Minimal repros for the legacy-pi-compat resolution corruption and the RpcClient.pid accessor, filed upstream.
- Per-fix removal tasks (walk, patch) so each workaround dies with its upstream fix.
- A wontfix branch: if either issue closes wontfix, an ADR accepts the workaround as permanent with an upgrade-time re-verification contract, and the corresponding removal task closes as overtaken.

## Not in scope

- Maintaining a fork; the patch exists to be deleted.

## Acceptance

- [ ] Both issues are filed with a minimal repro; links are recorded in the tree.
- [ ] Each removal task names the exact code that goes away when its fix lands.

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1501](../tasks/T-1501-repro-import-meta-resolve.md) | Minimal repro: Bun.plugin corruption of import.meta.resolve | Done |
| [T-1502](../tasks/T-1502-file-upstream-issues.md) | File both pi-coding-agent issues | Done |
| [T-1503](../tasks/T-1503-drop-resolve-walk.md) | Remove the node_modules walk once upstream ships | Blocked |
| [T-1504](../tasks/T-1504-drop-rpc-pid-patch.md) | Remove the RpcClient.pid patch once upstream ships | Blocked |
