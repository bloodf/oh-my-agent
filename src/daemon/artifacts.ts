/**
 * Purpose: Lavish sessions as the console sees them — the HTML artifacts
 * agents opened for review, read from Lavish's own state file — and the one
 * action the console needs: resume a session so its URL answers again.
 *
 * Public API: `listArtifacts(stateDir)`, `openArtifact(file, stateDir)`,
 * `ArtifactSession`.
 *
 * Upstream deps: node fs for `state.json`; `npx -y lavish-axi` (or `bunx`)
 * for resume. Lavish is not a dependency of this package — it is an AXI the
 * agents run on demand — so the daemon runs it the same way they do.
 *
 * Downstream consumers: `./console-api` (`/api/artifacts`).
 *
 * Failure modes: no state file is an empty list. A resume that fails
 * surfaces the CLI's last stderr line, never a hung request: it is bounded
 * to thirty seconds.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ArtifactSession {
	/** Absolute path of the HTML artifact; the session's identity. */
	file: string;
	/** The review URL on the local Lavish server. */
	url: string;
	status: string;
	pendingPrompts: number;
	updatedAt: string;
}

interface StoredSession {
	file?: unknown;
	url?: unknown;
	status?: unknown;
	pending_prompts?: unknown;
	updated_at?: unknown;
}

/** Every session Lavish knows, newest first. */
export async function listArtifacts(
	stateDir: string,
): Promise<ArtifactSession[]> {
	let parsed: { sessions?: Record<string, StoredSession> };
	try {
		parsed = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
	} catch {
		return [];
	}
	const sessions = Object.values(parsed.sessions ?? {})
		.filter(
			(s): s is StoredSession & { file: string; url: string } =>
				typeof s.file === "string" && typeof s.url === "string",
		)
		.map((s) => ({
			file: s.file,
			url: s.url,
			status: typeof s.status === "string" ? s.status : "open",
			pendingPrompts:
				typeof s.pending_prompts === "number" ? s.pending_prompts : 0,
			updatedAt: typeof s.updated_at === "string" ? s.updated_at : "",
		}));
	return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Resume (or open) a session without launching a browser, and answer its
 * URL. `npx` when the machine has node, `bunx` otherwise: the daemon runs
 * under bun, but Lavish declares node, so node is tried first.
 */
export async function openArtifact(
	file: string,
	stateDir: string,
	options: { run?: typeof runCli; timeoutMs?: number } = {},
): Promise<ArtifactSession> {
	const run = options.run ?? runCli;
	await run(["lavish-axi", file, "--no-open", "--reopen"], {
		env: { LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_NO_OPEN: "1" },
		timeoutMs: options.timeoutMs ?? 30_000,
	});
	const session = (await listArtifacts(stateDir)).find((s) => s.file === file);
	if (!session)
		throw new Error(`Lavish opened ${file} but recorded no session`);
	return session;
}

/** Run one Lavish CLI invocation through npx or bunx, bounded. */
export async function runCli(
	args: string[],
	options: { env: Record<string, string>; timeoutMs: number },
): Promise<void> {
	const launcher = Bun.which("npx")
		? ["npx", "-y", ...args]
		: ["bunx", ...args];
	const child = Bun.spawn(launcher, {
		env: { ...process.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill(), options.timeoutMs);
	try {
		const [code, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		if (code !== 0) {
			const last = stderr.trim().split("\n").at(-1) ?? "";
			throw new Error(`lavish-axi exited ${code}${last ? `: ${last}` : ""}`);
		}
	} finally {
		clearTimeout(timer);
	}
}
