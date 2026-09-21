/**
 * Purpose: Resolve how the console and TUI draw an author. A stored image or
 * glyph wins; otherwise the face is a blobatar generated from the wire name.
 *
 * Public API: `ResolvedAvatar`, `resolveAvatar`, `isImageAvatar`,
 * `thinkingActors`.
 *
 * Upstream deps: none. Rendering (React adapter, SVG string, TUI swatch)
 * lives beside the surface that paints.
 *
 * Downstream consumers: the web console profile, AvatarTile, MessageAvatar,
 * the TUI manager, and tests/avatar.test.ts.
 */
export type ResolvedAvatar =
	| { kind: "image"; src: string }
	| { kind: "glyph"; text: string }
	| { kind: "blobatar"; name: string };

const IMAGE_AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,/;

/** True when the stored avatar is an uploaded image data URL. */
export function isImageAvatar(avatar: string | undefined): avatar is string {
	return typeof avatar === "string" && IMAGE_AVATAR.test(avatar);
}

/**
 * Pick the drawing for one author. `stored` is the profile field; `author`
 * is the wire identity (`@you`, a peer name) used as the blobatar seed.
 */
export function resolveAvatar(
	stored: string | undefined,
	author: string,
): ResolvedAvatar {
	if (stored && IMAGE_AVATAR.test(stored))
		return { kind: "image", src: stored };
	if (stored) return { kind: "glyph", text: stored };
	return { kind: "blobatar", name: author };
}

/** Who currently holds ⏳ on any of these messages — a turn in progress. */
export function thinkingActors(
	messages: ReadonlyArray<{
		reactions?: ReadonlyArray<{ actor: string; emoji: string }>;
	}>,
): Set<string> {
	const actors = new Set<string>();
	for (const message of messages) {
		for (const reaction of message.reactions ?? []) {
			if (reaction.emoji === "⏳") actors.add(reaction.actor);
		}
	}
	return actors;
}
