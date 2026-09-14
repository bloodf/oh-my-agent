/**
 * Avatar validation in `mergeProfile`: a persona avatar is one to four
 * graphemes, or a small base64 image data URL, and nothing else.
 */
import { describe, expect, test } from "bun:test";
import {
	EMPTY_PROFILE,
	MAX_AVATAR_IMAGE_BYTES,
	mergeProfile,
} from "../src/daemon/profile";

/** A data URL whose base64 payload decodes to exactly `bytes` bytes. */
function imageUrl(bytes: number, mime = "png"): string {
	return `data:image/${mime};base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
}

const withAvatar = (avatar: unknown) =>
	mergeProfile(EMPTY_PROFILE, { operator: { avatar } });

describe("profile avatars", () => {
	test("graphemes: one emoji, up to four characters, and not five", () => {
		expect(withAvatar("🧭").operator.avatar).toBe("🧭");
		// A family emoji is several code points but one grapheme.
		expect(withAvatar("👨‍👩‍👧‍👦").operator.avatar).toBe("👨‍👩‍👧‍👦");
		expect(withAvatar(" AB12 ").operator.avatar).toBe("AB12");
		expect(() => withAvatar("12345")).toThrow("1 to 4 characters");
		expect(() => withAvatar("a\nb")).toThrow("one line");
	});

	test("an image data URL of every allowed type is accepted", () => {
		for (const mime of ["png", "jpeg", "webp", "gif"]) {
			const url = imageUrl(1_024, mime);
			expect(withAvatar(url).operator.avatar).toBe(url);
		}
		const agent = mergeProfile(EMPTY_PROFILE, {
			agents: { reviewer: { avatar: imageUrl(64, "webp") } },
		});
		expect(agent.agents.reviewer?.avatar).toBe(imageUrl(64, "webp"));
	});

	test("an image at the cap is accepted and one byte over is refused", () => {
		// Sizes where base64 pads with one and two `=` exercise the padding math.
		for (const bytes of [
			MAX_AVATAR_IMAGE_BYTES,
			MAX_AVATAR_IMAGE_BYTES - 1,
			MAX_AVATAR_IMAGE_BYTES - 2,
		]) {
			expect(withAvatar(imageUrl(bytes)).operator.avatar).toBe(imageUrl(bytes));
		}
		expect(() => withAvatar(imageUrl(MAX_AVATAR_IMAGE_BYTES + 1))).toThrow(
			"at most 200 KB",
		);
	});

	test("a mime outside png, jpeg, webp, and gif is refused", () => {
		for (const url of [
			imageUrl(16, "svg+xml"),
			imageUrl(16, "bmp"),
			`data:text/html;base64,${btoa("<b>x</b>")}`,
			// The same bytes without the base64 marker.
			`data:image/png,${Buffer.alloc(16).toString("base64")}`,
		]) {
			expect(() => withAvatar(url)).toThrow("base64 data URL");
		}
	});

	test("a payload that is not base64 is refused", () => {
		for (const payload of ["", "abc", "ab$d", "ab=d", "a===", "YWJj\nZA=="]) {
			expect(() => withAvatar(`data:image/png;base64,${payload}`)).toThrow(
				"not valid base64",
			);
		}
	});

	test("the refusal is whole: nothing of a bad patch is merged", () => {
		const current = mergeProfile(EMPTY_PROFILE, {
			operator: { displayName: "Heitor", avatar: "🧭" },
		});
		expect(() =>
			mergeProfile(current, {
				operator: { avatar: imageUrl(MAX_AVATAR_IMAGE_BYTES + 1) },
			}),
		).toThrow();
		expect(current.operator).toEqual({ displayName: "Heitor", avatar: "🧭" });
	});
});
