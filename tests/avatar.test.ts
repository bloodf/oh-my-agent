/**
 * How an author is drawn: a stored image or glyph wins; otherwise a blobatar
 * from the wire name. Thinking actors are whoever currently holds ⏳.
 */
import { describe, expect, test } from "bun:test";
import {
	isImageAvatar,
	resolveAvatar,
	thinkingActors,
} from "../src/shared/avatar";
import {
	blobatarBodyFill,
	blobatarSvg,
	tuiFaceMark,
} from "../src/shared/tui-face";

describe("resolveAvatar", () => {
	test("an empty stored avatar is a blobatar of the wire author", () => {
		expect(resolveAvatar(undefined, "@you")).toEqual({
			kind: "blobatar",
			name: "@you",
		});
		expect(resolveAvatar("", "reviewer")).toEqual({
			kind: "blobatar",
			name: "reviewer",
		});
	});

	test("a stored glyph is kept", () => {
		expect(resolveAvatar("🧭", "@you")).toEqual({
			kind: "glyph",
			text: "🧭",
		});
	});

	test("a stored image data URL is kept", () => {
		const src = "data:image/png;base64,AAAA";
		expect(resolveAvatar(src, "reviewer")).toEqual({ kind: "image", src });
		expect(isImageAvatar(src)).toBe(true);
		expect(isImageAvatar("🧭")).toBe(false);
	});
});

describe("thinkingActors", () => {
	test("actors who currently hold the hourglass are thinking", () => {
		const actors = thinkingActors([
			{
				reactions: [
					{ actor: "@you", emoji: "👀" },
					{ actor: "mate", emoji: "⏳" },
				],
			},
			{ reactions: [{ actor: "scout", emoji: "✅" }] },
		]);
		expect([...actors]).toEqual(["mate"]);
	});

	test("no hourglass means nobody is thinking", () => {
		expect(
			thinkingActors([{ reactions: [{ actor: "mate", emoji: "👀" }] }]).size,
		).toBe(0);
		expect(thinkingActors([]).size).toBe(0);
	});
});

describe("blobatar seed", () => {
	test("the same wire name is the same SVG", () => {
		expect(blobatarSvg("reviewer")).toBe(blobatarSvg("reviewer"));
		expect(blobatarSvg("reviewer")).not.toBe(blobatarSvg("@you"));
		expect(blobatarSvg("reviewer")).toContain("<svg");
	});
});

describe("tuiFaceMark", () => {
	test("plain is a disc; colored wraps the blobatar body fill", () => {
		expect(tuiFaceMark("alpha", false)).toBe("●");
		expect(blobatarBodyFill("alpha")).toMatch(/^#[0-9a-fA-F]{6}$/);
		const colored = tuiFaceMark("alpha", true);
		expect(colored.startsWith("\x1b[38;2;")).toBe(true);
		expect(colored.endsWith("m●\x1b[0m")).toBe(true);
		expect(colored).not.toBe(tuiFaceMark("bravo", true));
	});
});
