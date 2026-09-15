/**
 * Purpose: Read request failures and format server timestamps without letting
 * a malformed value throw inside a render.
 * Public API: errorText, hasErrorCode, formatDate.
 * Upstream deps: Intl only.
 * Downstream consumers: console views that show API errors or dates.
 * Failure modes: an unparseable date renders as its raw text instead of
 * throwing RangeError; an unknown error renders as its string form.
 */

/** The user-facing text of a failure, without the "Error: " prefix String() adds. */
export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Whether a failure carries this API error code. Reads `.code` when the
 * request layer attached it and falls back to the message, which older
 * builds set to the code itself.
 */
export function hasErrorCode(cause: unknown, code: string): boolean {
  if (cause && typeof cause === "object" && (cause as { code?: unknown }).code === code) return true;
  return errorText(cause).includes(code);
}

/** Format a timestamp; a value Intl cannot format comes back as raw text. */
export function formatDate(value: string | number, options: Intl.DateTimeFormatOptions): string {
  if (value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, options).format(date);
}
