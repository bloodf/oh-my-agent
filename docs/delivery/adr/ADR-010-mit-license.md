# ADR-010 — MIT license, chosen by the repository owner

**Status:** Accepted

## Context

The repository is public and ships package metadata pointing at it. A public repo with no `LICENSE` is not public domain: it is all-rights-reserved by default, so a reader may look but has no grant to use, fork, or depend on it. Adding a `license` field to `package.json` while no license text exists would be worse than the silence, because tooling would report a grant that was never made. The choice was deferred to the owner rather than made by the generator, because a license binds every future contributor.

## Decision

MIT. The owner chose it on 2026-08-27, and the two halves land in one change: the `LICENSE` text and the `license` field in `package.json`, so tooling never reports a grant without text behind it.

## Consequences

- T-703 ships both halves together; a `license` field without a `LICENSE` file (or the reverse) is the mismatch this record exists to prevent.
- Publishing to a registry is unblocked; the deferral was the only thing standing in its way.
- Contributors get a permissive grant with no patent clause; that simplicity is accepted as the cost of MIT.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Keep deferring | A public repo without a license is all-rights-reserved; the deferral was a forcing function, not an end state. |
| Apache-2.0 | The patent grant is real, but the project is a local plugin and MIT's brevity fits its surface. |
| Set `license: UNLICENSED` | Accurate for a private package, misleading for a public repository that intends to be usable. |

## Evidence

| Claim | Source |
|---|---|
| MIT license text | [`./LICENSE`](../../.././LICENSE) |
| Package license field | [`./package.json`](../../.././package.json) |
