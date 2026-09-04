/**
 * Purpose: Inspect one operator-selected Git worktree and read its changed-file
 * diffs using fixed, read-only Git commands.
 *
 * Public API: `inspectWorkspace`, `readWorkspaceDiff`, and their workspace DTOs.
 *
 * Upstream deps: Node filesystem/path primitives and Bun's subprocess API.
 *
 * Downstream consumers: the authenticated console API composed by `main.ts`.
 *
 * Failure modes: rejects invalid or inaccessible directories, non-repositories,
 * paths absent from current Git status, command failures, timeouts, and oversized
 * status output. Diff output is safely cut off and marked `truncated` instead.
 * Calls are read-only and safe to retry.
 *
 * Performance: status output is capped at 4 MiB, diff output at 1 MiB, stderr at
 * 64 KiB, and every Git process has a 10-second deadline.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const COMMAND_TIMEOUT_MS = 10_000;
const STATUS_LIMIT = 4 * 1024 * 1024;
const DIFF_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export interface WorkspaceFileStatus {
	path: string;
	originalPath?: string;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
}

export interface WorkspaceInspection {
	cwd: string;
	root: string;
	branch: string | null;
	files: WorkspaceFileStatus[];
}

export interface WorkspaceDiff {
	path: string;
	diff: string;
	truncated: boolean;
	binary: boolean;
}

interface CommandResult {
	stdout: Uint8Array;
	stderr: Uint8Array;
	exitCode: number;
	truncated: boolean;
}

interface RepositoryContext {
	cwd: string;
	root: string;
	files: WorkspaceFileStatus[];
	filterConfig: string[];
}

class OutputLimitError extends Error {}

function gitEnvironment(): Record<string, string | undefined> {
	const environment = { ...process.env };
	for (const name of Object.keys(environment)) {
		if (
			name === "GIT_DIR" ||
			name === "GIT_WORK_TREE" ||
			name === "GIT_COMMON_DIR" ||
			name === "GIT_INDEX_FILE" ||
			name === "GIT_OBJECT_DIRECTORY" ||
			name === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
			name === "GIT_EXEC_PATH" ||
			name === "GIT_CONFIG_COUNT" ||
			name === "GIT_CONFIG_PARAMETERS" ||
			/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)
		) {
			delete environment[name];
		}
	}
	return {
		...environment,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_EXTERNAL_DIFF: "",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function collect(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	truncate: boolean,
	onLimit: () => void,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let wasTruncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = limit - size;
			if (value.byteLength > remaining) {
				if (truncate && remaining > 0)
					chunks.push(value.subarray(0, remaining));
				size += Math.max(remaining, 0);
				wasTruncated = true;
				onLimit();
				if (!truncate)
					throw new OutputLimitError(`Git output exceeded ${limit} bytes`);
				break;
			}
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated: wasTruncated };
}

async function runGit(
	cwd: string,
	args: string[],
	options: {
		stdoutLimit?: number;
		truncateStdout?: boolean;
		acceptedExitCodes?: number[];
		config?: string[];
	} = {},
): Promise<CommandResult> {
	const process = Bun.spawn({
		cmd: [
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"diff.external=",
			"-c",
			"pager.diff=false",
			...(options.config ?? []).flatMap((value) => ["-c", value]),
			...args,
		],
		cwd,
		env: gitEnvironment(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let stdoutLimited = false;
	const timer = setTimeout(() => {
		timedOut = true;
		process.kill(9);
	}, COMMAND_TIMEOUT_MS);
	const killForOutput = (): void => {
		stdoutLimited = true;
		process.kill(9);
	};
	const killForError = (): void => process.kill(9);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			collect(
				process.stdout,
				options.stdoutLimit ?? STATUS_LIMIT,
				options.truncateStdout ?? false,
				options.truncateStdout ? killForOutput : killForError,
			),
			collect(process.stderr, STDERR_LIMIT, false, killForError),
			process.exited,
		]);
		if (timedOut)
			throw new Error(`Git command timed out after ${COMMAND_TIMEOUT_MS}ms`);
		const accepted = options.acceptedExitCodes ?? [0];
		if (
			!accepted.includes(exitCode) &&
			!(stdoutLimited && options.truncateStdout)
		) {
			const message = new TextDecoder().decode(stderr.bytes).trim();
			throw new Error(message || `Git exited with status ${exitCode}`);
		}
		return {
			stdout: stdout.bytes,
			stderr: stderr.bytes,
			exitCode,
			truncated: stdout.truncated,
		};
	} finally {
		clearTimeout(timer);
		if (process.exitCode === null) {
			process.kill(9);
			await process.exited.catch(() => undefined);
		}
	}
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function stripTerminator(value: string): string {
	return value.endsWith("\r\n")
		? value.slice(0, -2)
		: value.endsWith("\n")
			? value.slice(0, -1)
			: value;
}

function decodeDiff(
	bytes: Uint8Array,
	truncated: boolean,
): { diff: string; binary: boolean } {
	try {
		return {
			diff: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			binary: false,
		};
	} catch {
		if (truncated) {
			for (let trim = 1; trim <= 3 && trim < bytes.byteLength; trim += 1) {
				try {
					return {
						diff: new TextDecoder("utf-8", { fatal: true }).decode(
							bytes.subarray(0, -trim),
						),
						binary: false,
					};
				} catch {
					// A partial UTF-8 code point may occupy up to four bytes.
				}
			}
		}
		return { diff: "", binary: true };
	}
}

async function canonicalDirectory(cwd: string): Promise<string> {
	if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
		throw new Error("cwd must be a non-empty directory path");
	}
	const canonical = await realpath(cwd);
	if (!(await stat(canonical)).isDirectory())
		throw new Error("cwd is not a directory");
	return canonical;
}

function parseStatus(bytes: Uint8Array): WorkspaceFileStatus[] {
	const fields = decode(bytes).split("\0");
	if (fields.at(-1) === "") fields.pop();
	const files: WorkspaceFileStatus[] = [];

	for (let index = 0; index < fields.length; index += 1) {
		const entry = fields[index];
		if (entry.length < 4 || entry[2] !== " ")
			throw new Error("Git returned malformed status output");
		const indexStatus = entry[0];
		const worktreeStatus = entry[1];
		const file: WorkspaceFileStatus = {
			path: entry.slice(3),
			indexStatus,
			worktreeStatus,
			staged: indexStatus !== " " && indexStatus !== "?",
			unstaged: worktreeStatus !== " ",
			untracked: indexStatus === "?" && worktreeStatus === "?",
		};
		if (
			indexStatus === "R" ||
			indexStatus === "C" ||
			worktreeStatus === "R" ||
			worktreeStatus === "C"
		) {
			const originalPath = fields[index + 1];
			if (originalPath === undefined)
				throw new Error("Git returned an incomplete rename status");
			file.originalPath = originalPath;
			index += 1;
		}
		files.push(file);
	}
	return files;
}

async function repositoryContext(cwd: string): Promise<RepositoryContext> {
	const canonicalCwd = await canonicalDirectory(cwd);
	const rootResult = await runGit(canonicalCwd, [
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
	]);
	const root = await realpath(stripTerminator(decode(rootResult.stdout)));
	const filterConfig = await safeFilterConfig(root);
	const status = await runGit(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		{ config: filterConfig },
	);
	return {
		cwd: canonicalCwd,
		root,
		files: parseStatus(status.stdout),
		filterConfig,
	};
}

async function safeFilterConfig(root: string): Promise<string[]> {
	const configured = await runGit(
		root,
		["config", "--null", "--name-only", "--list"],
		{ acceptedExitCodes: [0, 1] },
	);
	if (configured.exitCode === 1) return [];
	const drivers = new Set<string>();
	for (const key of decode(configured.stdout).split("\0")) {
		if (key === "") continue;
		const match = /^(filter\..+)\.(clean|process|required)$/i.exec(key);
		if (!match) continue;
		drivers.add(match[1]);
	}
	return [...drivers].flatMap((driver) => [
		`${driver}.clean=`,
		`${driver}.process=`,
		`${driver}.required=false`,
	]);
}

async function currentBranch(root: string): Promise<string | null> {
	const result = await runGit(
		root,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		{
			acceptedExitCodes: [0, 1],
		},
	);
	return result.exitCode === 0 ? stripTerminator(decode(result.stdout)) : null;
}

function validateChangedPath(
	root: string,
	path: string,
	files: WorkspaceFileStatus[],
): WorkspaceFileStatus {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.includes("\0") ||
		isAbsolute(path)
	) {
		throw new Error("path must be a non-empty repository-relative path");
	}
	const absolute = resolve(root, path);
	const fromRoot = relative(root, absolute);
	if (
		fromRoot === "" ||
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	) {
		throw new Error("path escapes the repository root");
	}
	const file = files.find((candidate) => candidate.path === path);
	if (!file)
		throw new Error(`path is not present in repository status: ${path}`);
	return file;
}

export async function inspectWorkspace(
	cwd: string,
): Promise<WorkspaceInspection> {
	const context = await repositoryContext(cwd);
	return {
		cwd: context.cwd,
		root: context.root,
		branch: await currentBranch(context.root),
		files: context.files,
	};
}

export async function readWorkspaceDiff(
	cwd: string,
	path: string,
	staged: boolean,
): Promise<WorkspaceDiff> {
	if (typeof staged !== "boolean") throw new Error("staged must be a boolean");
	const context = await repositoryContext(cwd);
	const file = validateChangedPath(context.root, path, context.files);
	if (staged && !file.staged)
		throw new Error(`path has no staged change: ${path}`);
	if (!staged && !file.unstaged && !file.untracked)
		throw new Error(`path has no unstaged change: ${path}`);

	let args: string[];
	let acceptedExitCodes = [0];
	if (file.untracked) {
		const filePath = resolve(context.root, file.path);
		const metadata = await lstat(filePath);
		if (!metadata.isFile()) {
			throw new Error(`untracked path is not a regular file: ${path}`);
		}
		const canonicalFilePath = await realpath(filePath);
		const canonicalFromRoot = relative(context.root, canonicalFilePath);
		if (
			canonicalFromRoot === "" ||
			canonicalFromRoot === ".." ||
			canonicalFromRoot.startsWith(`..${sep}`) ||
			isAbsolute(canonicalFromRoot)
		) {
			throw new Error(
				`untracked path resolves outside the repository root: ${path}`,
			);
		}
		args = [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-index",
			"--",
			"/dev/null",
			file.path,
		];
		acceptedExitCodes = [0, 1];
	} else {
		args = ["diff", "--no-ext-diff", "--no-textconv"];
		if (staged) args.push("--cached");
		args.push("--", `:(literal)${file.path}`);
	}

	const result = await runGit(context.root, args, {
		stdoutLimit: DIFF_LIMIT,
		truncateStdout: true,
		acceptedExitCodes,
		config: context.filterConfig,
	});
	const decoded = decodeDiff(result.stdout, result.truncated);
	const binary =
		decoded.binary ||
		/(^|\n)(Binary files .* differ|GIT binary patch)(\n|$)/.test(decoded.diff);
	return {
		path: file.path,
		diff: decoded.diff,
		truncated: result.truncated,
		binary,
	};
}
