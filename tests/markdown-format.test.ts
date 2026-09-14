/**
 * Composer formatting toolbar: Markdown edits at a textarea selection.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { applyFormat, insertText } from "../web/src/lib/markdown-format";

const sel = (value: string, start: number, end = start) => ({
	value,
	start,
	end,
});

describe("markdown-format", () => {
	test("wraps a selection and keeps it selected", () => {
		expect(applyFormat("bold", sel("make bold now", 5, 9))).toEqual(
			sel("make **bold** now", 7, 11),
		);
		expect(applyFormat("italic", sel("a b", 2, 3))).toEqual(sel("a _b_", 3, 4));
		expect(applyFormat("strike", sel("x", 0, 1))).toEqual(sel("~~x~~", 2, 3));
		expect(applyFormat("code", sel("", 0))).toEqual(sel("``", 1));
	});

	test("toggles a wrap off when already wrapped", () => {
		expect(applyFormat("bold", sel("make **bold** now", 7, 11))).toEqual(
			sel("make bold now", 5, 9),
		);
	});

	test("link selects the url placeholder", () => {
		const out = applyFormat("link", sel("see docs", 4, 8));
		expect(out.value).toBe("see [docs](url)");
		expect(out.value.slice(out.start, out.end)).toBe("url");
		expect(applyFormat("link", sel("", 0)).value).toBe("[text](url)");
	});

	test("code block fences on their own lines", () => {
		const out = applyFormat("codeBlock", sel("run x", 4, 5));
		expect(out.value).toBe("run \n```\nx\n```");
		expect(out.value.slice(out.start, out.end)).toBe("x");
		expect(applyFormat("codeBlock", sel("", 0)).value).toBe("```\n\n```");
	});

	test("lists prefix every selected line and toggle back", () => {
		const ordered = applyFormat("orderedList", sel("a\nb\nc", 0, 3));
		expect(ordered.value).toBe("1. a\n2. b\nc");
		expect(applyFormat("orderedList", ordered).value).toBe("a\nb\nc");
		const bullet = applyFormat("bulletList", sel("one\ntwo", 5));
		expect(bullet).toEqual(sel("one\n- two", 9));
	});

	test("insertText replaces the selection and moves the caret", () => {
		expect(insertText(sel("hi there", 3, 8), "@")).toEqual(sel("hi @", 4));
		expect(insertText(sel("x", 9), "😀").value).toBe("x😀");
	});
});
