# T-1633 — Default avatars are blobatars

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

Every author with no stored avatar draws a blobatar generated from their wire name in the console, the public demo, the homepage transcript, and the TUI manager; a ⏳ mid-turn takes the thinking pose; custom glyphs and images still override.

## Read first

- [The decision](../../../docs/delivery/adr/ADR-019-blobatar-default-avatars.md)
- [The resolver](../../../src/shared/avatar.ts)
- [The library](https://github.com/Alain00/blobatar)

## Files this task may change

- `src/shared/avatar.ts`
- `src/shared/tui-face.ts`
- `src/extension/manager.ts`
- `src/daemon/profile.ts`
- `package.json`
- `bun.lock`
- `tsconfig.json`
- `biome.json`
- `tests/avatar.test.ts`
- `tests/build-hygiene.test.ts`
- `tests/extension.test.ts`
- `tests/console-client.test.ts`
- `web/package.json`
- `web/bun.lock`
- `web/components.json`
- `web/src/App.tsx`
- `web/src/components/ui/blobatar.tsx`
- `web/src/console/profile.ts`
- `web/src/console/thinking.tsx`
- `web/src/console/WorkspaceToolbar.tsx`
- `web/src/console/Message.tsx`
- `web/src/console/ConsoleShell.tsx`
- `web/src/console/Storybook.tsx`
- `web/src/console/ProfileDialog.tsx`
- `web/src/console/CreateAgentDialog.tsx`
- `web/src/console/definition/AvatarEditor.tsx`
- `web/src/console/definition/identity-sections.tsx`
- `website/package.json`
- `website/bun.lock`
- `website/src/mock/fixtures/agents.ts`
- `website/src/mock/fixtures/index.ts`
- `website/src/components/home/sections/Transcript.tsx`
- `website/src/app/(home)/story.css`
- `website/public/home/console.png`
- `website/public/home/collaboration.png`
- `docs/assets/console.png`
- `docs/assets/collaboration.png`
- `docs/guide/console.md`
- `docs/web-console.md`
- `web/DESIGN.md`
- `CHANGELOG.md`
- `scripts/capture-console-assets.ts`
- `src/console/app.js`
- `src/console/style.css`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/shared/avatar.ts`](../../../src/shared/avatar.ts) | New | resolveAvatar and thinkingActors; empty stored avatar is a blobatar of the wire name. |
| [`src/shared/tui-face.ts`](../../../src/shared/tui-face.ts) | New | TUI disc from the blobatar body fill. |
| [`web/src/components/ui/blobatar.tsx`](../../../web/src/components/ui/blobatar.tsx) | New | shadcn Avatar composition with a blobatar fallback. |
| [`web/src/console/thinking.tsx`](../../../web/src/console/thinking.tsx) | New | Actors holding ⏳ on loaded messages. |
| [`tests/avatar.test.ts`](../../../tests/avatar.test.ts) | New | Empty is blobatar; glyph and image win; same name same SVG; TUI disc. |
| [`scripts/capture-console-assets.ts`](../../../scripts/capture-console-assets.ts) | New | Storybook screenshots for docs/assets and the website. |
| [`src/extension/manager.ts`](../../../src/extension/manager.ts) | Edited | Each agent row starts with a blobatar disc. |
| [`src/daemon/profile.ts`](../../../src/daemon/profile.ts) | Edited | Empty avatar means consoles draw a blobatar from the wire name. |
| [`package.json`](../../../package.json) | Edited | blobatar is the plugin's only runtime dependency. |
| [`bun.lock`](../../../bun.lock) | Edited | Locked blobatar. |
| [`tsconfig.json`](../../../tsconfig.json) | Edited | Exclude leftover web-next/ from tsc. |
| [`biome.json`](../../../biome.json) | Edited | Ignore leftover web-next/. |
| [`tests/build-hygiene.test.ts`](../../../tests/build-hygiene.test.ts) | Edited | blobatar is the only allowed runtime dependency. |
| [`tests/extension.test.ts`](../../../tests/extension.test.ts) | Edited | Manager rows include the disc. |
| [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) | Edited | Empty profile draws a blobatar; a glyph still wins. |
| [`web/package.json`](../../../web/package.json) | Edited | blobatar and @blobatar/react. |
| [`web/bun.lock`](../../../web/bun.lock) | Edited | Locked. |
| [`web/components.json`](../../../web/components.json) | Edited | The @blobatar shadcn registry. |
| [`web/src/App.tsx`](../../../web/src/App.tsx) | Edited | Loads blobatar/motion.css for the thinking pose. |
| [`web/src/console/profile.ts`](../../../web/src/console/profile.ts) | Edited | personaFor no longer invents initials; resolveAvatar is the drawing. |
| [`web/src/console/WorkspaceToolbar.tsx`](../../../web/src/console/WorkspaceToolbar.tsx) | Edited | AvatarTile draws image, glyph, or blobatar; thinking pose while ⏳. |
| [`web/src/console/Message.tsx`](../../../web/src/console/Message.tsx) | Edited | Message avatars use AvatarTile. |
| [`web/src/console/ConsoleShell.tsx`](../../../web/src/console/ConsoleShell.tsx) | Edited | ThinkingProvider from loaded messages. |
| [`web/src/console/Storybook.tsx`](../../../web/src/console/Storybook.tsx) | Edited | Empty profile fixtures; researcher holds ⏳. |
| [`web/src/console/ProfileDialog.tsx`](../../../web/src/console/ProfileDialog.tsx) | Edited | Empty field is a blobatar of the wire name. |
| [`web/src/console/CreateAgentDialog.tsx`](../../../web/src/console/CreateAgentDialog.tsx) | Edited | Preview is a blobatar of the draft name. |
| [`web/src/console/definition/AvatarEditor.tsx`](../../../web/src/console/definition/AvatarEditor.tsx) | Edited | Empty preview is a blobatar. |
| [`web/src/console/definition/identity-sections.tsx`](../../../web/src/console/definition/identity-sections.tsx) | Edited | Passes the wire name into the editor. |
| [`website/package.json`](../../../website/package.json) | Edited | blobatar and @blobatar/react. |
| [`website/bun.lock`](../../../website/bun.lock) | Edited | Locked. |
| [`website/src/mock/fixtures/agents.ts`](../../../website/src/mock/fixtures/agents.ts) | Edited | Demo seed has names, no emoji avatars. |
| [`website/src/mock/fixtures/index.ts`](../../../website/src/mock/fixtures/index.ts) | Edited | STATE_VERSION 3 so old demo storage reseeds. |
| [`website/src/components/home/sections/Transcript.tsx`](../../../website/src/components/home/sections/Transcript.tsx) | Edited | Homepage faces are blobatars. |
| [`website/src/app/(home)/story.css`](../../../website/src/app/%28home%29/story.css) | Edited | Avatar tile is the blobatar, not a letter plate. |
| [`website/public/home/console.png`](../../../website/public/home/console.png) | Edited | Storybook capture of the populated console. |
| [`website/public/home/collaboration.png`](../../../website/public/home/collaboration.png) | Edited | Storybook capture of the open thread. |
| [`docs/assets/console.png`](../../../docs/assets/console.png) | Edited | Storybook capture of the populated console. |
| [`docs/assets/collaboration.png`](../../../docs/assets/collaboration.png) | Edited | Storybook capture of the open thread. |
| [`docs/guide/console.md`](../../../docs/guide/console.md) | Edited | Default avatar is a blobatar. |
| [`docs/web-console.md`](../../../docs/web-console.md) | Edited | Default avatar is a blobatar. |
| [`web/DESIGN.md`](../../../web/DESIGN.md) | Edited | Message avatars default to a blobatar. |
| [`CHANGELOG.md`](../../../CHANGELOG.md) | Edited | Unreleased: default avatars are blobatars. |
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Regenerated from web/. |
| [`src/console/style.css`](../../../src/console/style.css) | Edited | Regenerated from web/. |

## Steps

1. Resolve empty avatars to a blobatar of the wire name; keep stored glyphs and images.
2. Paint that face in the console, the demo, the homepage transcript, and the TUI manager.
3. Hold the thinking pose while the actor has ⏳ on a loaded message.
4. Regenerate the conversation and collaboration screenshots from the storybook.

## Acceptance

- [x] An empty profile draws a blobatar from the wire author, proven by reverting the fallback line.
- [x] A stored glyph or image still draws instead of a blobatar.
- [x] A ⏳ reaction puts that actor's default blobatar in the thinking pose.
- [x] The TUI manager row includes a disc of the blobatar body color.

Evidence:

| Claim | Anchor |
|---|---|
| Empty stored avatar is a blobatar of the wire author | [`tests/avatar.test.ts`](../../../tests/avatar.test.ts) |
| Browser: default face is a blobatar; a glyph still wins | [`tests/console-client.test.ts`](../../../tests/console-client.test.ts) |
| Manager rows include the disc | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |

## Out of scope

- Wiping stored custom avatars. Gaze. A self-hosted blobatar HTTP endpoint.

## Depends on

- T-1632

## Unblocks

- Nothing.
