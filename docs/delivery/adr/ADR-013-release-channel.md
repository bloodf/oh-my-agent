# ADR-013 — One npm package with a files allowlist; tagged releases, never per-commit publishes

**Status:** Accepted

## Context

The plugin works from a checkout but has no version story: no `files` allowlist, no changelog, no release workflow, and a `patchedDependencies` patch that would silently not travel with a published artifact. Shipping without deciding this means the first release is improvised, and improvisation with a credential-bearing daemon is how a private path or the patch contract leaks into a tarball.

## Decision

Distribution is a single npm package with an explicit `files` allowlist; versions are semver with a CHANGELOG; releases use an operator-dispatched CI run with a required tag input. Every dispatch verifies the tag, runs the full gate suite, packs once, and runs the consumer-install smoke against that tarball; npm publication then runs automatically using the same verified tarball, subject to the npm-publish environment gate. The `RpcClient.pid` patch cannot travel with the artifact because Bun honors `patchedDependencies` only from the consumer's root manifest, while pi-coding-agent reaches the consumer as a peerDependency. Publication therefore gates on the consumer-install smoke test (T-1306), which installs the packed tarball into a clean project and asserts the pid contract state of the resolved peer. Until EP-15 lands the accessor upstream, that state is 'pid absent, degraded supervision' and the release notes must state it; after T-1504 the state flips to 'pid present' and the same test enforces it. No silent drift in either direction. Amended 2026-09-10 by T-1504: the patch is removed without an upstream accessor, because the daemon now records each worker's pid from its launch shim. The resolved peer's state stays 'pid absent', which the same smoke test still enforces, but supervision no longer degrades on a consumer install.

## Consequences

- A consumer install no longer runs with degraded supervision: the launch shim records the worker pid, and the smoke test still asserts the resolved peer lacks the accessor, so an upstream change is noticed rather than silently relied on.
- With the patch gone there is no pin to go stale; the peer range tracks the OMP minor the suites were verified on, and T-1305's gate passes with no patches at all.
- Every release is reproducible: operator-supplied tag, gates, one verified tarball, then explicit publish, with no artifact rebuild between verification and publication.
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
| The pid patch, added in d374d76 and removed by T-1504 | `d374d76` |
