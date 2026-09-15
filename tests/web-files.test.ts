/**
 * `web-files`: the console's directory browser and the attachment paths a
 * chat prompt may reference.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachmentReferences, listWebFiles } from "../src/daemon/web-files";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-web-files-")));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("listWebFiles", () => {
	test("a directory past the cap keeps folders first and reports truncation", async () => {
		const dir = await tempDir();
		await Promise.all(
			Array.from({ length: 1005 }, (_, i) =>
				writeFile(join(dir, `f-${String(i).padStart(4, "0")}`), ""),
			),
		);
		await mkdir(join(dir, "zz-folder"));
		const listing = await listWebFiles(dir);
		expect(listing.truncated).toBe(true);
		expect(listing.entries).toHaveLength(1000);
		expect(listing.entries[0]).toEqual({
			name: "zz-folder",
			path: join(dir, "zz-folder"),
			directory: true,
		});
		expect(listing.entries[1]?.name).toBe("f-0000");
		expect(listing.entries.at(-1)?.name).toBe("f-0998");
	});

	test("a small directory is not truncated", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "one"), "");
		const listing = await listWebFiles(dir);
		expect(listing.truncated).toBe(false);
		expect(listing.entries.map((entry) => entry.name)).toEqual(["one"]);
	});
});

describe("attachmentReferences", () => {
	test("absent paths add nothing and real files are listed canonically", async () => {
		const dir = await tempDir();
		const file = join(dir, "notes.txt");
		await writeFile(file, "x");
		expect(await attachmentReferences(undefined)).toBe("");
		expect(await attachmentReferences([])).toBe("");
		expect(await attachmentReferences([file])).toBe(
			`\n\nAttached local files (read these paths with your tools):\n${JSON.stringify(file)}`,
		);
	});

	test("more than 20 paths are refused and 20 are accepted", async () => {
		const dir = await tempDir();
		const file = join(dir, "notes.txt");
		await writeFile(file, "x");
		await expect(
			attachmentReferences(Array.from({ length: 21 }, () => file)),
		).rejects.toThrow("At most 20 attachment paths are allowed");
		expect(
			await attachmentReferences(Array.from({ length: 20 }, () => file)),
		).toContain(JSON.stringify(file));
	});

	test("relative paths, non-strings, and directories are refused", async () => {
		const dir = await tempDir();
		await expect(attachmentReferences(["notes.txt"])).rejects.toThrow(
			"Attachments require absolute paths",
		);
		await expect(attachmentReferences([42])).rejects.toThrow(
			"Attachments require absolute paths",
		);
		await expect(attachmentReferences("not-an-array")).rejects.toThrow(
			"At most 20 attachment paths are allowed",
		);
		await expect(attachmentReferences([dir])).rejects.toThrow(
			"Attachment must be a file",
		);
	});
});
