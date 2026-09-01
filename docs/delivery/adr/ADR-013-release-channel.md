# ADR-013 — One npm package with a files allowlist; tagged releases, never per-commit publishes

**Status:** Accepted

## Context

The plugin works from a checkout but has no version story: no `files` allowlist, no changelog, no release workflow, and a `patchedDependencies` patch that would silently not travel with a published artifact. Shipping without deciding this means the first release is improvised, and improvisation with a credential-bearing daemon is how a private path or the patch contract leaks into a tarball.

## Decision

Distribution is a single npm package with an explicit `files` allowlist; versions are semver with a CHANGELOG; releases are tag-driven CI runs that execute the full gate suite, `npm pack` dry-run, then publish. The `RpcClient.pid` patch cannot travel with the artifact — Bun honors `patchedDependencies` only from the consumer's root manifest, and pi-coding-agent reaches the consumer as a peerDependency — so publish gates on the consumer-install smoke test (T-1306), which installs the packed tarball into a clean project and asserts the pid contract state of the resolved peer. Until EP-15 lands the accessor upstream, that state is 'pid absent, degraded supervision' and the release notes must state it; after T-1504 the state flips to 'pid present' and the same test enforces it. No silent drift in either direction.

## Consequences

- A release may ship before EP-15 lands, but only with the degraded-supervision state named in its release notes — the smoke test makes the state explicit instead of letting a user discover it.
- The patch pin (18.0.7) is already stale against the peer range (^18.0.7) and the registry head; T-1305's gate asserts patch keys match the lockfile-resolved version.
- Every release is reproducible: tag → gates → pack → publish, with no hand steps.
- Git-only installs stay supported for development but are not a release channel.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Apply the patch at pack time | Bun honors patchedDependencies only from the consumer's root manifest and the tarball cannot modify a resolved peerDependency; vendoring a forked peer breaks the OMP plugin model. |
| Git installs as the primary channel | No version story for consumers and no CI gate on what ships; the daemon's own gates cannot run against a moving main. |
| Publish on every commit | Releases stop being a decision, and every main-branch breakage becomes a version someone may have installed. |

## Evidence

| Claim | Source |
|---|---|
| Patch that must travel with any release | [`patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch`](../../../patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch) |
