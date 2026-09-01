# ADR-013 — One npm package with a files allowlist; tagged releases, never per-commit publishes

**Status:** Proposed

## Context

The plugin works from a checkout but has no version story: no `files` allowlist, no changelog, no release workflow, and a `patchedDependencies` patch that would silently not travel with a published artifact. Shipping without deciding this means the first release is improvised, and improvisation with a credential-bearing daemon is how a private path or the patch contract leaks into a tarball.

## Decision

Distribution is a single npm package with an explicit `files` allowlist; versions are semver with a CHANGELOG; releases are tag-driven CI runs that execute the full gate suite, `npm pack` dry-run, then publish. The `patchedDependencies` story is part of the artifact contract: either the `RpcClient.pid` patch is upstreamed (EP-15) or the release pipeline applies the patch at pack time — the release task owns that call, and the pack test proves the tarball carries whatever resolution shipped.

## Consequences

- Publishing the plugin before EP-15 resolves the patch question ships a runtime whose pinned contract (pid accessor) is absent — the pack test must catch this.
- Every release is reproducible: tag → gates → pack → publish, with no hand steps.
- Git-only installs stay supported for development but are not a release channel.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Git installs as the primary channel | No version story for consumers and no CI gate on what ships; the daemon's own gates cannot run against a moving main. |
| Publish on every commit | Releases stop being a decision, and every main-branch breakage becomes a version someone may have installed. |

## Evidence

| Claim | Source |
|---|---|
| Patch that must travel with any release | [`patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch) |
