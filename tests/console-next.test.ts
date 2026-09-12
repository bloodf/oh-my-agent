/**
 * The server-rendered console (web-next) against a real daemon: pages are
 * rendered on the server with the operator token held there, Markdown
 * arrives as HTML, and the live stream relays the daemon's frames.
 *
 * Slow on purpose — it builds and starts Next — so `test:fast` skips it and
 * the full suite runs it. Needs `web-next/node_modules` (CI installs it).
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerFactory } from "../src/daemon/runtime";
import { bootDaemon } from "../src/daemon/runtime";

const ROOT = join(import.meta.dir, "..");
const WEB_NEXT = join(ROOT, "web-next");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const stubWorkerFactory: WorkerFactory = async ({ peer }) => ({
	name: peer.name,
	state: "running",
	prompt: async () => {},
	park: async () => {},
	resume: async () => {},
	stop: async () => {},
});

async function freePort(): Promise<number> {
	const probe = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = probe.port;
	probe.stop(true);
	return port;
}

async function waitFor<T>(
	label: string,
	read: () => Promise<T>,
	ok: (v: T) => boolean,
	ms = 30_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await read();
			if (ok(last)) return last;
		} catch {
			// Not up yet.
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(
		`Timed out waiting for ${label}; last: ${JSON.stringify(last)}`,
	);
}

describe("web-next server-rendered console", () => {
	test("renders a room with Markdown as HTML, keeps the token server-side, and relays live frames", async () => {
		if (!existsSync(join(WEB_NEXT, "node_modules", "next"))) {
			throw new Error(
				"web-next dependencies are not installed: bun install --cwd web-next --frozen-lockfile",
			);
		}
		// One build per checkout; CI has none and builds here.
		if (!existsSync(join(WEB_NEXT, ".next", "BUILD_ID"))) {
			const build = Bun.spawn(["bun", "run", "build"], {
				cwd: WEB_NEXT,
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await build.exited;
			if (code !== 0)
				throw new Error(
					`next build failed: ${await new Response(build.stderr).text()}`,
				);
		}

		const agentDir = await mkdtemp(join(tmpdir(), "oma-next-"));
		cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
		const logs: string[] = [];
		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir: agentDir,
			workerFactory: stubWorkerFactory,
			logger: (m) => logs.push(m),
		});
		cleanups.push(() => handle.close());
		const consoleUrl = logs
			.map((l) => /https?:\/\/\S+/.exec(l)?.[0])
			.find((u) => u && new URL(u).searchParams.has("token"));
		if (!consoleUrl) throw new Error("daemon printed no console URL");
		const daemon = new URL(consoleUrl);
		const token = daemon.searchParams.get("token") as string;
		const api = (path: string, init: RequestInit = {}) =>
			fetch(new URL(path, daemon.origin), {
				...init,
				headers: {
					"X-Operator-Token": token,
					"content-type": "application/json",
					...(init.headers ?? {}),
				},
			});
		expect(
			(
				await api("/api/channels", {
					method: "POST",
					body: JSON.stringify({ id: "#reviews" }),
				})
			).status,
		).toBe(201);
		expect(
			(
				await api("/api/channels/%23reviews/messages", {
					method: "POST",
					body: JSON.stringify({
						body: "## Findings\n\n- inline `code`\n\n| a | b |\n|---|---|\n| 1 | **2** |",
					}),
				})
			).status,
		).toBe(201);

		const port = await freePort();
		const server = Bun.spawn(
			["bun", "run", "start", "--", "-p", String(port)],
			{
				cwd: WEB_NEXT,
				env: {
					...process.env,
					OMA_CONSOLE_URL: consoleUrl,
					PORT: String(port),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		cleanups.push(() => {
			server.kill();
		});
		const base = `http://127.0.0.1:${port}`;
		await waitFor(
			"next to answer",
			() => fetch(`${base}/agents`).then((r) => r.status),
			(s) => s === 200,
		);

		const page = await fetch(`${base}/rooms/%23reviews`);
		expect(page.status).toBe(200);
		const html = await page.text();
		// Rendered on the server: the Markdown is already HTML, no client render.
		expect(html).toContain("<h2");
		expect(html).toContain("Findings");
		expect(html).toContain("<table");
		expect(html).toContain("<strong>2</strong>");
		expect(html).toContain('data-author="@you"');
		// The operator token never reaches the browser.
		expect(html).not.toContain(token);
		// No diagram on the page: mermaid is not among the scripts it loads.
		expect(html).not.toMatch(/mermaid/i);

		// The proxy answers with the daemon's data, token added server-side.
		const proxied = (await (await fetch(`${base}/api/channels`)).json()) as {
			channels: { id: string }[];
		};
		expect(proxied.channels.map((c) => c.id)).toContain("#reviews");

		// The live stream opens against the daemon and relays a message frame.
		const live = await fetch(`${base}/api/live`);
		expect(live.headers.get("content-type")).toContain("text/event-stream");
		const reader = live.body?.getReader();
		if (!reader) throw new Error("no live body");
		const decoder = new TextDecoder();
		let seen = "";
		const read = async (until: string) => {
			const deadline = Date.now() + 15_000;
			while (!seen.includes(until) && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				seen += decoder.decode(value);
			}
			return seen;
		};
		await read("event: open");
		await api("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "live one" }),
		});
		const frames = await read("live one");
		expect(frames).toContain("event: frame");
		expect(frames).toContain('"type":"message"');
		await reader.cancel();
	}, 180_000);
});
