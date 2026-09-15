import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectWorkspace,
	readWorkspaceDiff,
} from "../src/daemon/workspace-changes";

async function git(cwd: string, ...args: string[]): Promise<string> {
	return gitWithInput(cwd, "ignore", ...args);
}

async function gitWithInput(
	cwd: string,
	stdin: "ignore" | Uint8Array,
	...args: string[]
): Promise<string> {
	const child = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stdin,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`,
		);
	}
	return stdout;
}

async function withRepository<T>(
	run: (root: string) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "oma-workspace-changes-"));
	try {
		await git(root, "init", "--quiet");
		await git(root, "config", "user.name", "Workspace Test");
		await git(root, "config", "user.email", "workspace@example.test");
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function commitAll(root: string): Promise<void> {
	await git(root, "add", "--all");
	await git(root, "commit", "--quiet", "-m", "fixture");
}

describe("workspace changes", () => {
	test("repository clean and process filters never execute during inspection or diff reads", async () => {
		await withRepository(async (root) => {
			await writeFile(
				join(root, ".gitattributes"),
				"clean.txt filter=malicious-clean\nprocess.txt filter=malicious-process\n",
			);
			await writeFile(join(root, "clean.txt"), "clean before\n");
			await writeFile(join(root, "process.txt"), "process before\n");
			await commitAll(root);

			// Configure only after the fixture commit: setup itself must not invoke a filter.
			await git(
				root,
				"config",
				"filter.malicious-clean.clean",
				"touch clean-marker",
			);
			await git(root, "config", "filter.malicious-clean.required", "true");
			await git(
				root,
				"config",
				"filter.malicious-process.process",
				"touch process-marker",
			);
			await git(root, "config", "filter.malicious-process.required", "true");
			await writeFile(join(root, "clean.txt"), "clean after\n");
			await writeFile(join(root, "process.txt"), "process after\n");

			const inspection = await inspectWorkspace(root);
			expect(inspection.files.map((file) => file.path).sort()).toEqual([
				"clean.txt",
				"process.txt",
			]);
			expect(await Bun.file(join(root, "clean-marker")).exists()).toBe(false);
			expect(await Bun.file(join(root, "process-marker")).exists()).toBe(false);

			const cleanDiff = await readWorkspaceDiff(root, "clean.txt", false);
			const processDiff = await readWorkspaceDiff(root, "process.txt", false);
			expect(cleanDiff.diff).toContain("+clean after");
			expect(processDiff.diff).toContain("+process after");
			expect(await Bun.file(join(root, "clean-marker")).exists()).toBe(false);
			expect(await Bun.file(join(root, "process-marker")).exists()).toBe(false);
		});
	});

	test("a wildcard filename is passed as a literal pathspec", async () => {
		await withRepository(async (root) => {
			await writeFile(join(root, "*.txt"), "literal before\n");
			await writeFile(join(root, "sibling.txt"), "sibling before\n");
			await commitAll(root);
			await writeFile(join(root, "*.txt"), "literal selected\n");
			await writeFile(join(root, "sibling.txt"), "sibling excluded\n");

			const result = await readWorkspaceDiff(root, "*.txt", false);
			expect(result.path).toBe("*.txt");
			expect(result.diff).toContain("+literal selected");
			expect(result.diff).not.toContain("sibling excluded");
			expect(result.binary).toBe(false);
			expect(result.truncated).toBe(false);
		});
	});

	test("an untracked symlink cannot expose a file outside the repository", async () => {
		const outside = await mkdtemp(join(tmpdir(), "oma-workspace-outside-"));
		try {
			await writeFile(join(outside, "secret.txt"), "external secret\n");
			await withRepository(async (root) => {
				await writeFile(join(root, "tracked.txt"), "tracked\n");
				await commitAll(root);
				await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

				const inspection = await inspectWorkspace(root);
				expect(inspection.files).toContainEqual({
					path: "escape.txt",
					indexStatus: "?",
					worktreeStatus: "?",
					staged: false,
					unstaged: true,
					untracked: true,
				});
				await expect(
					readWorkspaceDiff(root, "escape.txt", false),
				).rejects.toThrow("untracked path is not a regular file");
			});
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("binary changes are identified without decoding their payload as text", async () => {
		await withRepository(async (root) => {
			await writeFile(join(root, "payload.bin"), new Uint8Array([0, 1, 2, 3]));
			await commitAll(root);
			await writeFile(join(root, "payload.bin"), new Uint8Array([0, 1, 9, 3]));

			const result = await readWorkspaceDiff(root, "payload.bin", false);
			expect(result.path).toBe("payload.bin");
			expect(result.binary).toBe(true);
			expect(result.truncated).toBe(false);
		});
	});

	test("clean filters configured inside a submodule never execute during inspection", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "oma-workspace-submodule-"));
		try {
			const upstream = join(scratch, "upstream");
			const marker = join(scratch, "submodule-filter-marker");
			await mkdir(upstream);
			await git(upstream, "init", "--quiet");
			await git(upstream, "config", "user.name", "Workspace Test");
			await git(upstream, "config", "user.email", "workspace@example.test");
			await writeFile(
				join(upstream, ".gitattributes"),
				"*.txt filter=nested\n",
			);
			await writeFile(join(upstream, "inner.txt"), "inner before\n");
			await commitAll(upstream);

			await withRepository(async (root) => {
				await writeFile(join(root, "outer.txt"), "outer\n");
				await commitAll(root);
				await git(
					root,
					"-c",
					"protocol.file.allow=always",
					"submodule",
					"add",
					"--quiet",
					upstream,
					"nested",
				);
				await commitAll(root);

				const nested = join(root, "nested");
				// A clone keeps no identity of its own; CI has no global one.
				await git(nested, "config", "user.name", "Workspace Test");
				await git(nested, "config", "user.email", "workspace@example.test");
				// Move the submodule commit so its gitlink shows as changed.
				await writeFile(join(nested, "inner.txt"), "inner second\n");
				await commitAll(nested);
				await git(nested, "config", "filter.nested.clean", `touch '${marker}'`);
				await git(nested, "config", "filter.nested.required", "true");
				// Same size, new mtime: a dirty check must hash the content, which runs clean.
				await writeFile(join(nested, "inner.txt"), "inner third!\n");

				const inspection = await inspectWorkspace(root);
				expect(await Bun.file(marker).exists()).toBe(false);
				expect(inspection.files.map((file) => file.path)).toEqual(["nested"]);
				expect(inspection.truncated).toBe(false);

				const diff = await readWorkspaceDiff(root, "nested", false);
				expect(diff.diff).toContain("Subproject commit");
				expect(diff.diff).not.toContain("-dirty");
				expect(await Bun.file(marker).exists()).toBe(false);
			});
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	test("a filename that is not valid UTF-8 does not break inspection", async () => {
		await withRepository(async (root) => {
			await writeFile(join(root, "tracked.txt"), "tracked before\n");
			await commitAll(root);
			await writeFile(join(root, "tracked.txt"), "tracked after\n");

			// Stage a Latin-1 path through the index so the fixture works on
			// filesystems that refuse non-UTF-8 names.
			const blob = (
				await gitWithInput(
					root,
					new TextEncoder().encode("latin1\n"),
					"hash-object",
					"-w",
					"--stdin",
				)
			).trim();
			const entry = Buffer.concat([
				Buffer.from(`100644 ${blob}\t`),
				Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]),
				Buffer.from([0]),
			]);
			await gitWithInput(root, entry, "update-index", "-z", "--index-info");

			const inspection = await inspectWorkspace(root);
			const paths = inspection.files.map((file) => file.path).sort();
			expect(paths).toEqual(["caf\uFFFD.txt", "tracked.txt"]);
			await expect(
				readWorkspaceDiff(root, "caf\uFFFD.txt", true),
			).rejects.toThrow("not valid UTF-8");
			const diff = await readWorkspaceDiff(root, "tracked.txt", false);
			expect(diff.diff).toContain("+tracked after");
		});
	});

	test("status output past the limit is truncated to whole entries instead of failing", async () => {
		await withRepository(async (root) => {
			await writeFile(join(root, "tracked.txt"), "tracked\n");
			await commitAll(root);
			// About 800 bytes per status entry, so 5,400 entries exceed 4 MiB.
			const directory = join("a".repeat(200), "b".repeat(200), "c".repeat(200));
			await mkdir(join(root, directory), { recursive: true });
			const suffix = "x".repeat(190);
			const count = 5_400;
			for (let start = 0; start < count; start += 500) {
				await Promise.all(
					Array.from({ length: Math.min(500, count - start) }, (_, offset) =>
						writeFile(join(root, directory, `${start + offset}-${suffix}`), ""),
					),
				);
			}

			const inspection = await inspectWorkspace(root);
			expect(inspection.truncated).toBe(true);
			expect(inspection.files.length).toBeGreaterThan(0);
			expect(inspection.files.length).toBeLessThan(count);
			const complete = new RegExp(`^${directory}/\\d+-${suffix}$`);
			for (const file of inspection.files) {
				expect(file.untracked).toBe(true);
				expect(file.path).toMatch(complete);
			}
		});
	}, 60_000);
});
