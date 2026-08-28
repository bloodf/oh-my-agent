# EP-07 — Release readiness: CI, lint, and a README a stranger can act on

**Status:** Done

*Derived from the tasks below.*

## Outcome

Every push is type-checked, tested, and checked for delivery-doc drift by a machine, the code has one enforced style, and the repository's front door explains what this is and how to run it.

## Why this is its own epic

Everything else in this tree is verified by a suite somebody has to remember to run. That is not verification, it is a habit, and habits do not survive a handover. This epic is also where the delivery tree itself becomes checkable: the generator is only a source of truth if a stale committed tree fails a build rather than sitting there looking authoritative.

## In scope

- GitHub Actions workflow: install, typecheck, test, and a delivery-doc regeneration diff.
- Biome configuration plus lint and format scripts.
- Root README and the package metadata that points at the repository.

## Not in scope

- Publishing to a registry, which is blocked on the license decision (ADR-010).
- Choosing a license; that is the owner's call, recorded as deferred.
- Release automation, tagging, or changelog generation.

## Acceptance

- [x] A push runs `tsc --noEmit` and `bun test` and fails the build on either.
- [x] A commit whose `docs/delivery/` differs from what the generator produces fails CI.
- [x] `bun run lint` reports the same result locally and in CI.
- [x] The root README explains what the plugin is, how to install it, and where the delivery tree lives.
- [x] `package.json` carries repository, homepage, bugs, keywords, an engines constraint, and the MIT license field matching `LICENSE` (ADR-010).

## Decisions

- [ADR-010](../adr/ADR-010-mit-license.md) — MIT license, chosen by the repository owner

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-701](../tasks/T-701-ci-workflow.md) | CI: typecheck, test, and delivery-doc drift | Done |
| [T-702](../tasks/T-702-biome-lint.md) | Biome lint and format configuration | Done |
| [T-703](../tasks/T-703-root-readme-and-metadata.md) | Root README and package metadata | Done |
| [T-704](../tasks/T-704-deflake-intermittent-test.md) | Identify and fix the intermittent test failure | Done |
