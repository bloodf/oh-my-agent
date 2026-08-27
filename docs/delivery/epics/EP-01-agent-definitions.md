# EP-01 — Peer definitions and private store

**Status:** Done

## Outcome

A peer is described by one markdown file with YAML frontmatter, parsed into a typed definition with a stable fingerprint.

## Why this is its own epic

The definition is the single seam between what a user writes and everything the daemon does: discovery, materialization, sandbox policy, scheduling, and rooms all read it. Parsing it in one place with strict unknown-key rejection stops a silent typo from becoming a silently unenforced policy.

## In scope

- OMP task-agent frontmatter plus the plugin's own extras.
- Strict validation: unknown top-level and nested keys are rejected.
- Content fingerprint driving staleness detection.

## Not in scope

- Loading definitions from disk, which belongs to the daemon store task.

## Acceptance

- [x] Native OMP keys and plugin extras both parse into `PeerDefinition`.
- [x] An unknown key at any level raises `PeerParsingError` with a code.
- [x] The fingerprint changes when any effective field changes.

## Decisions

- [ADR-002](../adr/ADR-002-private-store-materialized-roots.md) — Peer definitions live in a private store and are materialized per worker

## Tasks

| Task | Title | Status |
|---|---|---|
| [T-101](../tasks/T-101-peer-definition-parser.md) | Peer definition parser | Done |
