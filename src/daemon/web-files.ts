import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_LISTED_ENTRIES = 1000;

/** Privileged operator-only browsing. Paths are not a worker capability grant. */
export async function listWebFiles(path: string) {
	const selected = path || homedir();
	if (!isAbsolute(selected))
		throw new Error("An absolute directory path is required");
	const canonical = await realpath(selected);
	const directory = await opendir(canonical);
	const entries: { name: string; path: string; directory: boolean }[] = [];
	// The whole directory is read before the cap, so folders sort first and
	// the entries kept are the first by name rather than whichever the
	// filesystem yielded first. A directory of millions of entries is read in
	// full; a bounded heap would fix that if it ever matters.
	for await (const entry of directory) {
		const full = join(canonical, entry.name);
		const info = entry.isSymbolicLink()
			? await stat(full).catch(() => null)
			: entry;
		if (!info) continue;
		entries.push({
			name: entry.name,
			path: full,
			directory: info.isDirectory(),
		});
	}
	entries.sort(
		(a, b) =>
			Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
	);
	return {
		path: canonical,
		parent: dirname(canonical),
		entries: entries.slice(0, MAX_LISTED_ENTRIES),
		truncated: entries.length > MAX_LISTED_ENTRIES,
	};
}

export async function attachmentReferences(value: unknown) {
	if (value === undefined) return "";
	if (!Array.isArray(value) || value.length > 20)
		throw new Error("At most 20 attachment paths are allowed");
	const paths: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length > 4096 || !isAbsolute(item))
			throw new Error("Attachments require absolute paths");
		const path = await realpath(item);
		if (!(await stat(path)).isFile())
			throw new Error("Attachment must be a file");
		paths.push(path);
	}
	return paths.length
		? `\n\nAttached local files (read these paths with your tools):\n${paths.map((path) => JSON.stringify(path)).join("\n")}`
		: "";
}
