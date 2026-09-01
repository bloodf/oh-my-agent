# EP-13 — Distribution: packable artifact, versioning, and release CI

**Status:** Ready

*Derived from the tasks below.*

## Outcome

The plugin ships as one npm package with a version story — a files allowlist, a changelog, and a tag-driven release pipeline that runs the gates before anything publishes.

## Why this is its own epic

The plugin installs and runs from a checkout, but nothing about a release is reproducible: no tarball contract, no version policy, and a patchedDependencies story that does not survive npm pack today. Improvising the first release with a credential-bearing daemon is how a private path or the patch contract ends up in a tarball.

## In scope

- A files allowlist in the manifest and a pack test that proves the tarball contains exactly what the plugin needs.
- Semver + CHANGELOG + a tag-driven release workflow that runs gates first, publishes second.
- A decision on how the pi-coding-agent patch travels with the artifact (ADR-013; upstreaming is EP-15).

## Not in scope

- Blocking the first release on EP-15's upstream filings; distribution soft-depends on T-1502 being filed, but the only hard gate is T-1306's contract assertion.
- Releases on every commit; release is a tag, not a push.

## Acceptance

- [ ] `npm pack` dry-run output is asserted in CI: no unintended file ships, and the patch story is explicit.
- [ ] A release is a tag; CI runs the full gate suite before publish.
- [ ] The README's install section describes installing the released artifact, not the repo.

## Decisions

- [ADR-013](../adr/ADR-013-release-channel.md) — One npm package with a files allowlist; tagged releases, never per-commit publishes

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-1301](../tasks/T-1301-packable-artifact.md) | Files allowlist and the pack test | Ready |
| [T-1302](../tasks/T-1302-versioning-policy.md) | Semver policy and the changelog | Ready |
| [T-1303](../tasks/T-1303-release-ci.md) | Tag-driven release workflow | Blocked |
| [T-1304](../tasks/T-1304-install-docs.md) | README install path for the released artifact | Blocked |
| [T-1305](../tasks/T-1305-patch-hygiene-gate.md) | patches/ contains code only, enforced | Ready |
| [T-1306](../tasks/T-1306-consumer-install-smoke.md) | Consumer-install smoke test | Blocked |
