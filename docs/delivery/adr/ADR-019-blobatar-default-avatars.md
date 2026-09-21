# ADR-019 — Default avatars are in-process blobatars from the wire name

**Status:** Accepted

## Context

An empty profile drew two-letter initials on a hashed tint. The operator asked for https://github.com/Alain00/blobatar as the default face for every author.

## Decision

Generate blobatars in-process from the wire identity (`@you`, a peer name) with the `blobatar` package. Stored emoji glyphs and uploaded images remain optional overrides. A ⏳ reaction on a loaded message puts that actor's default blobatar in the thinking pose. The TUI paints the blobatar body fill as a colored disc. Never call blobatar.dev.

## Consequences

- The plugin's only runtime dependency is blobatar (zero transitive deps).
- Display-name edits do not change the face.
- Existing stored glyphs and images keep drawing until cleared.

## Alternatives considered

| Option | Why rejected |
|---|---|
| HTTP to blobatar.dev | Rate-limited, extra origin, faces vanish offline. |
| Seed from display name | A rename would change the creature. |
| Blobatar-only, drop glyphs | Operators already store emoji avatars; the daemon keeps accepting them. |

## Evidence

| Claim | Source |
|---|---|
| Empty stored avatar is a blobatar of the wire author | [`tests/avatar.test.ts`](../../../tests/avatar.test.ts) |
| Browser: default face is a blobatar; a glyph still wins | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
