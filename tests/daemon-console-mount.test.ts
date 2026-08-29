/**
 * RED tests for T-1001: the daemon serves the console.
 *
 * Public API under test: `bootDaemon(options) -> DaemonHandle`, specifically
 * the console listener it now owns — the operator-token lifecycle, the static
 * client at `/`, the API at `/api/*` on the same port, and the shutdown order
 * that frees that port.
 *
 * What exists only here: `tests/console-api.test.ts` covers the routes against
 * a hand-built server and `tests/console-client.test.ts` drives the client
 * through a proxy that rewrites its auth header. Neither boots a daemon, so
 * neither can catch a console that is never mounted, a token that rotates on
 * every restart, or a client whose own header the real server refuses. Those
 * are the properties asserted below.
 *
 * Every boot runs against a temp agent dir with an explicit `env`, so broker
 * discovery finds nothing and the real profile is never touched.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { hermeticChildEnv } from "./fixtures/hermetic-env";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-console-mount-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * A worker that never spawns a child. This suite is about the console
 * listener, not the RPC worker, which tests/worker-lifecycle.test.ts covers.
 */
const stubWorkerFactory: WorkerFactory = async ({ peer }) => {
	let state: SupervisedWorker["state"] = "running";
	return {
		name: peer.name,
		get state() {
			return state;
		},
		stderr: () => "",
		prompt: async () => {},
		park: async () => {
			state = "parked";
		},
		resume: async () => {
			state = "running";
		},
		stop: async () => {
			state = "stopped";
		},
	};
};

interface Booted {
	handle: DaemonHandle;
	agentDir: string;
	stateDir: string;
	tokenPath: string;
	logs: string[];
}

async function boot(
	options: {
		agentDir?: string;
		projectDir?: string;
		env?: Record<string, string | undefined>;
		register?: boolean;
	} = {},
): Promise<Booted> {
	const agentDir = options.agentDir ?? (await tempDir());
	const projectDir = options.projectDir ?? (await tempDir());
	const logs: string[] = [];

	const handle = await bootDaemon({
		env: options.env ?? {},
		agentDir,
		projectDir,
		workerFactory: stubWorkerFactory,
		logger: (message) => logs.push(message),
	});
	if (options.register !== false) cleanups.push(() => handle.close());

	const stateDir = join(agentDir, "oh-my-agent");
	return {
		handle,
		agentDir,
		stateDir,
		tokenPath: join(stateDir, "console-token"),
		logs,
	};
}

/**
 * The console URL the daemon printed at boot.
 *
 * Parsed out of the log rather than read off the handle on purpose: what an
 * operator can actually paste into a browser is the printed line, so that is
 * what these tests exercise.
 */
function printedConsoleUrl(logs: string[]): URL {
	const matches = logs
		.map((line) => /https?:\/\/\S+/.exec(line)?.[0])
		.filter((found): found is string => found !== undefined)
		.filter((found) => new URL(found).searchParams.has("token"));
	if (matches.length === 0) {
		throw new Error(`No console URL printed. Logs: ${JSON.stringify(logs)}`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Console URL printed more than once: ${matches.join(", ")}`,
		);
	}
	return new URL(matches[0] as string);
}

/** Mode bits only; the file type bits are not what 0600 is about. */
function permissionsOf(path: string): number {
	return statSync(path).mode & 0o777;
}

/**
 * One raw HTTP request, bypassing `fetch`'s URL normalization.
 *
 * `fetch` resolves `/../x` to `/x` before anything leaves the process, so a
 * traversal test written with `fetch` proves nothing about the server. This
 * writes the request line verbatim.
 */
async function rawRequest(
	url: URL,
	requestTarget: string,
): Promise<{ status: number; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let received = "";

	const socket = await Bun.connect({
		hostname: url.hostname,
		port: Number(url.port),
		socket: {
			data: (_socket, chunk) => {
				received += chunk.toString();
			},
			close: () => resolve(received),
			error: (_socket, error) => reject(error),
		},
	});
	socket.write(
		`GET ${requestTarget} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
	);

	const raw = await promise;
	const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
	const separator = raw.indexOf("\r\n\r\n");
	return { status, body: separator < 0 ? "" : raw.slice(separator + 4) };
}

// ── The token lifecycle ──────────────────────────────────────────────────────

describe("operator token", () => {
	test("first boot generates a token, stored 0600, and prints the URL once", async () => {
		const booted = await boot();

		const stored = (await readFile(booted.tokenPath, "utf8")).trim();
		expect(stored.length).toBeGreaterThanOrEqual(32);
		expect(permissionsOf(booted.tokenPath)).toBe(0o600);

		// Printed exactly once, carrying the token an operator needs.
		const url = printedConsoleUrl(booted.logs);
		expect(url.searchParams.get("token")).toBe(stored);
	});

	test("the printed URL names the bound port, and that port answers", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);

		expect(url.hostname).toBe("127.0.0.1");
		expect(Number(url.port)).toBeGreaterThan(0);

		// The port in the URL is the port serving, not a hopeful default.
		const response = await fetch(url);
		expect(response.status).toBe(200);
	});

	test("a restart reuses the stored token", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();

		const first = await boot({ agentDir, projectDir, register: false });
		const firstToken = printedConsoleUrl(first.logs).searchParams.get("token");
		await first.handle.close();

		const second = await boot({ agentDir, projectDir });
		const secondToken = printedConsoleUrl(second.logs).searchParams.get(
			"token",
		);

		expect(secondToken).toBeTruthy();
		expect(secondToken).toBe(firstToken);
		expect((await readFile(second.tokenPath, "utf8")).trim()).toBe(
			secondToken as string,
		);
	});

	test("deleting the token file rotates it", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();

		const first = await boot({ agentDir, projectDir, register: false });
		const firstToken = printedConsoleUrl(first.logs).searchParams.get("token");
		await first.handle.close();
		await rm(first.tokenPath, { force: true });

		const second = await boot({ agentDir, projectDir });
		expect(printedConsoleUrl(second.logs).searchParams.get("token")).not.toBe(
			firstToken,
		);
	});

	test("a token file with loose permissions fails the boot with a clear message", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await Bun.write(join(stateDir, "console-token"), "hunter2hunter2hunter2");
		await chmod(join(stateDir, "console-token"), 0o644);

		// Silently regenerating would lock the operator out of a URL they are
		// holding, with no explanation. Refusing says what to do.
		const attempt = bootDaemon({
			env: {},
			agentDir,
			projectDir,
			workerFactory: stubWorkerFactory,
		});
		await expect(attempt).rejects.toThrow(/console-token/);
		await expect(attempt).rejects.toThrow(/0600|permission/i);
	});

	test("a failed console boot strands nothing", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await Bun.write(join(stateDir, "console-token"), "hunter2hunter2hunter2");
		await chmod(join(stateDir, "console-token"), 0o644);

		await expect(
			bootDaemon({
				env: {},
				agentDir,
				projectDir,
				workerFactory: stubWorkerFactory,
			}),
		).rejects.toThrow();

		// The unwind stack ran: the pidfile is gone, so a corrected boot is not
		// refused as a double start.
		expect(await Bun.file(join(stateDir, "daemon.pid")).exists()).toBe(false);

		await chmod(join(stateDir, "console-token"), 0o600);
		const recovered = await boot({ agentDir, projectDir });
		expect(printedConsoleUrl(recovered.logs).searchParams.has("token")).toBe(
			true,
		);
	});
});

// ── One listener, two surfaces ───────────────────────────────────────────────

describe("serving the console", () => {
	test("GET / serves the client shell with the token", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);

		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");

		const body = await response.text();
		expect(body).toContain("oh-my-agent console");
		expect(body).toContain("app.js");
	});

	test("/index.html serves the same shell", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const shell = new URL(`/index.html${url.search}`, url);

		const response = await fetch(shell);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
	});

	test("the shell's own asset URLs load with correct content types", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);

		// Follow what the served HTML actually references rather than guessing
		// the paths: an asset the browser cannot fetch is a blank console, and
		// hardcoding the URLs here would hide exactly that. In-page anchors
		// (accessibility skip links) are not assets — filter them out.
		const html = await (await fetch(url)).text();
		const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
			.map((match) => match[1] as string)
			.filter((reference) => !reference.startsWith("#"));
		expect(references.length).toBeGreaterThanOrEqual(2);

		const types: Record<string, string> = {
			".js": "text/javascript",
			".css": "text/css",
		};
		for (const reference of references) {
			const asset = new URL(reference, url);
			const response = await fetch(asset);
			expect(`${reference} -> ${response.status}`).toBe(`${reference} -> 200`);
			const extension = reference.includes(".css") ? ".css" : ".js";
			expect(response.headers.get("content-type")).toContain(
				types[extension] as string,
			);
		}
	});

	test("the API answers on the same listener, by Bearer and by the client's own header", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;
		const agents = new URL("/api/agents", url);

		const bearer = await fetch(agents, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(bearer.status).toBe(200);
		expect(await bearer.json()).toHaveProperty("agents");

		// This is the header src/console/app.js actually sends. The browser
		// suite proxies it into Authorization; served for real, nothing does.
		const clientHeader = await fetch(agents, {
			headers: { "X-Operator-Token": token },
		});
		expect(clientHeader.status).toBe(200);
		expect(await clientHeader.json()).toHaveProperty("agents");
	});

	test("no token is 401 everywhere, and a wrong token is too", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const bare = new URL(url.pathname, url);

		for (const path of ["/", "/index.html", "/app.js", "/style.css"]) {
			const response = await fetch(new URL(path, bare));
			expect(`${path} -> ${response.status}`).toBe(`${path} -> 401`);
		}

		expect((await fetch(new URL("/api/agents", bare))).status).toBe(401);
		expect(
			(
				await fetch(new URL("/api/agents", bare), {
					headers: { Authorization: "Bearer not-the-token" },
				})
			).status,
		).toBe(401);
		expect((await fetch(new URL(`/?token=not-the-token`, bare))).status).toBe(
			401,
		);
	});

	test("an unknown non-API path is 404, not the shell", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);

		const response = await fetch(new URL(`/nope.txt${url.search}`, url));
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("oh-my-agent console");
	});

	test("an unknown API path keeps the API's own 404 shape", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		const response = await fetch(new URL("/api/nope", url), {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			error: { code: "not_found" },
		});
	});

	test("a write to a static path is refused, even with the token", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		// The client is read-only. A POST answered with the shell would suggest
		// this half of the server accepts writes it silently discards.
		for (const path of ["/", "/index.html", "/app.js", "/style.css"]) {
			const response = await fetch(new URL(path, url), {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: "{}",
			});
			expect(`${path} -> ${response.status}`).toBe(`${path} -> 405`);
		}
	});
});

// ── Traversal ────────────────────────────────────────────────────────────────

describe("static path containment", () => {
	test("a literal ../ request target is refused", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		const response = await rawRequest(
			url,
			`/../../package.json?token=${token}`,
		);
		expect(response.status).not.toBe(200);
		expect(response.body).not.toContain("oh-my-agent");
	});

	test("encoded traversal variants are refused", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		// Two levels, because `src/console/..` is `src/`, which holds no
		// package.json: a one-level climb 404s even with every guard removed,
		// which would make this test pass for the wrong reason. These reach the
		// repository root, where package.json really is.
		const targets = [
			"/%2e%2e/%2e%2e/package.json",
			"/%2e%2e%2f%2e%2e%2fpackage.json",
			"/..%2f..%2fpackage.json",
			"/app.js/../../../package.json",
			"/subdir/../../../package.json",
			"/....//....//package.json",
		];
		for (const target of targets) {
			const response = await rawRequest(url, `${target}?token=${token}`);
			expect(`${target} -> ${response.status}`).not.toBe(`${target} -> 200`);
			expect(response.body).not.toContain('"oh-my-agent"');
		}
	});

	test("a sibling source file outside src/console is not reachable", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		const response = await rawRequest(
			url,
			`/%2e%2e%2fdaemon%2fmain.ts?token=${token}`,
		);
		expect(response.status).not.toBe(200);
		expect(response.body).not.toContain("bootDaemon");
	});

	test("a file inside src/console that is not published is refused", async () => {
		const booted = await boot();
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		// Containment is satisfied here; only the published-file check refuses
		// it. Asserted so the two guards cannot collapse into one.
		const response = await rawRequest(url, `/../console/app.js?token=${token}`);
		expect(response.status).not.toBe(200);
	});
});

// ── Lifetime ─────────────────────────────────────────────────────────────────

describe("console lifetime", () => {
	test("OMA_CONSOLE_PORT pins the port", async () => {
		const booted = await boot({ env: { OMA_CONSOLE_PORT: "0" } });
		const url = printedConsoleUrl(booted.logs);
		expect(Number(url.port)).toBeGreaterThan(0);
	});

	test("shutdown frees the port and a second boot binds it cleanly", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();

		// Take an ephemeral port from a first boot, then demand that exact port
		// back: a listener that outlived its handle makes this fail to bind.
		const first = await boot({ agentDir, projectDir, register: false });
		const port = printedConsoleUrl(first.logs).port;
		await first.handle.close();

		expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

		const second = await boot({
			agentDir,
			projectDir,
			env: { OMA_CONSOLE_PORT: port },
		});
		const url = printedConsoleUrl(second.logs);
		expect(url.port).toBe(port);
		expect((await fetch(url)).status).toBe(200);
	});

	test("closing twice is safe", async () => {
		const booted = await boot({ register: false });
		await booted.handle.close();
		await booted.handle.close();
	});

	test("OMA_CONSOLE=0 mounts nothing", async () => {
		const booted = await boot({ env: { OMA_CONSOLE: "0" } });

		expect(booted.logs.filter((line) => /https?:\/\//.test(line))).toHaveLength(
			0,
		);
		// No console means no operator token to leak or manage.
		expect(await Bun.file(booted.tokenPath).exists()).toBe(false);
		// The daemon itself still came up. `existsSync`, not `Bun.file().exists()`:
		// the latter answers false for a unix socket, which is not a regular file.
		expect(existsSync(booted.handle.socketPath)).toBe(true);
	});

	test("the console closes before the room store it polls", async () => {
		const booted = await boot({ register: false });
		const url = printedConsoleUrl(booted.logs);
		const token = url.searchParams.get("token") as string;

		// Hold the live feed open: its poller reads the store every tick, so a
		// shutdown that closed the store first would throw against a closed
		// database on the way down.
		const socket = new WebSocket(
			`ws://${url.host}/api/events?token=${encodeURIComponent(token)}`,
		);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("ws failed")));
		});

		await booted.handle.close();

		// A store closed underneath a running poller surfaces as a logged error.
		expect(
			booted.logs.filter((line) => /closed database|SQLITE_MISUSE/i.test(line)),
		).toHaveLength(0);
	});
});

// ── The CLI an operator actually runs ────────────────────────────────────────

describe("omp-agent daemon — the printed URL", () => {
	test("the launcher relays a working console URL from the detached child", async () => {
		const agentDir = await tempDir();
		const mainPath = join(import.meta.dir, "..", "src", "daemon", "main.ts");
		const pidPath = join(agentDir, "oh-my-agent", "daemon.pid");

		// The detached child's stdio is closed, so anything it merely logs is
		// lost. This is the path that decides whether an operator ever sees the
		// URL at all — the in-process logger above cannot tell us.
		const launcher = Bun.spawn({
			cmd: [process.execPath, mainPath, "daemon"],
			env: hermeticChildEnv({
				PI_CODING_AGENT_DIR: agentDir,
				OMP_AUTH_BROKER_URL: "",
				OMP_AUTH_BROKER_TOKEN: "",
			}),
			cwd: agentDir,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const exitCode = await launcher.exited;
		const stdout = await new Response(launcher.stdout).text();
		const stderr = await new Response(launcher.stderr).text();
		if (exitCode !== 0) {
			throw new Error(`launcher exited ${exitCode}\n${stdout}\n${stderr}`);
		}

		cleanups.push(async () => {
			try {
				process.kill(Number(await Bun.file(pidPath).text()), "SIGTERM");
			} catch {
				// Already gone.
			}
		});

		const printed = stdout
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.startsWith("http://"));
		if (printed === undefined) {
			throw new Error(`launcher printed no console URL:\n${stdout}`);
		}

		// Paste-able, not merely well-formed: the daemon behind it answers.
		const url = new URL(printed);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.searchParams.get("token")).toBeTruthy();

		const shell = await fetch(url);
		expect(shell.status).toBe(200);
		expect(await shell.text()).toContain("oh-my-agent console");

		const api = await fetch(new URL("/api/agents", url), {
			headers: {
				Authorization: `Bearer ${url.searchParams.get("token") as string}`,
			},
		});
		expect(api.status).toBe(200);
	}, 60_000);
});
