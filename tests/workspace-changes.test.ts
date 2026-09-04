import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectWorkspace,
	readWorkspaceDiff,
} from "../src/daemon/workspace-changes";

async function git(cwd: string, ...args: string[]): Promise<void> {
	const child = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stdin: "ignore",
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
});
