/**
 * Purpose: Pure Markdown edits at a textarea selection for the composer's formatting toolbar.
 * Public API: TextSelection, FormatKind, applyFormat, insertText.
 * Upstream deps: none.
 * Downstream consumers: Composer.
 * Failure modes: out-of-range selections are clamped to the value.
 * Performance: linear in the edited value.
 */
export type TextSelection = { value: string; start: number; end: number };
export type FormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeBlock"
  | "link"
  | "orderedList"
  | "bulletList";

const WRAP: Partial<Record<FormatKind, string>> = {
  bold: "**",
  italic: "_",
  strike: "~~",
  code: "`",
};

function clamp({ value, start, end }: TextSelection): TextSelection {
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(0, Math.min(end, value.length));
  return { value, start: Math.min(a, b), end: Math.max(a, b) };
}

/** Replaces the selection with `text`; the caret lands after it. */
export function insertText(selection: TextSelection, text: string): TextSelection {
  const { value, start, end } = clamp(selection);
  const caret = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: caret, end: caret };
}

function wrap({ value, start, end }: TextSelection, marker: string): TextSelection {
  const before = value.slice(0, start);
  const after = value.slice(end);
  // Toggle off when the selection is already wrapped by this marker.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -marker.length) + value.slice(start, end) + after.slice(marker.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  return {
    value: before + marker + value.slice(start, end) + marker + after,
    start: start + marker.length,
    end: end + marker.length,
  };
}

function prefixLines({ value, start, end }: TextSelection, ordered: boolean): TextSelection {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const newline = value.indexOf("\n", end);
  const lineEnd = newline === -1 ? value.length : newline;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const pattern = ordered ? /^\d+\. / : /^- /;
  const block = lines.every((line) => pattern.test(line))
    ? lines.map((line) => line.replace(pattern, "")).join("\n")
    : lines.map((line, index) => `${ordered ? `${index + 1}. ` : "- "}${line}`).join("\n");
  const next = value.slice(0, lineStart) + block + value.slice(lineEnd);
  const caret = lineStart + block.length;
  return { value: next, start: lines.length === 1 && start === end ? caret : lineStart, end: caret };
}

/** Applies one toolbar format to the selection and returns the new value and selection. */
export function applyFormat(kind: FormatKind, selection: TextSelection): TextSelection {
  const range = clamp(selection);
  const { value, start, end } = range;
  const marker = WRAP[kind];
  if (marker) return wrap(range, marker);
  if (kind === "orderedList" || kind === "bulletList") return prefixLines(range, kind === "orderedList");
  if (kind === "link") {
    const text = value.slice(start, end) || "text";
    const inserted = `[${text}](url)`;
    const urlStart = start + text.length + 3;
    return { value: value.slice(0, start) + inserted + value.slice(end), start: urlStart, end: urlStart + 3 };
  }
  // codeBlock: fence on its own lines.
  const lead = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const open = `${lead}\`\`\`\n`;
  const inner = value.slice(start, end);
  return {
    value: `${value.slice(0, start)}${open}${inner}\n\`\`\`${value.slice(end)}`,
    start: start + open.length,
    end: start + open.length + inner.length,
  };
}

/** `@name` in message text; never swallows trailing sentence punctuation. */
export const MENTION_PATTERN = /(@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi;
