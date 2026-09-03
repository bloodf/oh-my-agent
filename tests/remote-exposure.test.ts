/**
 * T-1201 remote-mode trust boundaries plus T-1202 proxy URL correctness.
 *
 * The acceptance groups prove no listener ever answers a routable address;
 * remote console API and control requests require operator authentication,
 * while static files and WebSocket upgrades use short-lived one-time tickets;
 * secret files are verified before anything opens; forwarded identity requires
 * the proxy secret; an explicit external HTTPS origin is announced without a
 * long-lived token; and the loopback token URL remains unchanged.
 *
 * The control socket is asserted on its JSON-RPC error code rather than an
 * HTTP status: it answers `Response.json(unauthorized(0))` — HTTP 200 with a
 * failure envelope — and that is the wire contract every existing client
 * reads, so a status assertion here would be testing something the daemon has
 * never done.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { statSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/daemon/cli";
import { normalizeRequestUrl } from "../src/daemon/console-api";
import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
import { persistConnectionAuditState } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import type { JsonRpcFailure, JsonRpcSuccess } from "../src/shared/protocol";
import { ERROR_CODE } from "../src/shared/protocol";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * A worker that never spawns a child. This suite is about listeners and
 * credentials, not the RPC worker.
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

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-remote-exposure-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

interface Booted {
	handle: DaemonHandle;
	stateDir: string;
	messages: string[];
}
const defaultRemoteConsoleOrigin = "https://console.example.test";

function withRemoteConsoleOrigin(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return env.OMA_REMOTE === "1" && !("OMA_CONSOLE_ORIGIN" in env)
		? { ...env, OMA_CONSOLE_ORIGIN: defaultRemoteConsoleOrigin }
		: env;
}

async function boot(
	env: Record<string, string | undefined> = {},
	agentDir?: string,
): Promise<Booted> {
	const dir = agentDir ?? (await tempDir());
	const messages: string[] = [];
	const handle = await bootDaemon({
		env: withRemoteConsoleOrigin(env),
		agentDir: dir,
		projectDir: await tempDir(),
		workerFactory: stubWorkerFactory,
		logger: (message) => messages.push(message),
	});
	cleanups.push(() => handle.close());
	return { handle, stateDir: join(dir, "oh-my-agent"), messages };
}

async function bootRemoteConsole(): Promise<Booted & { localUrl: string }> {
	const booted = await boot({
		OMA_REMOTE: "1",
		OMA_CONSOLE_ORIGIN: "https://console.example.com",
	});
	const localUrl = booted.handle.consoleListenerUrl;
	if (localUrl === undefined) throw new Error("Remote console did not bind");
	return { ...booted, localUrl };
}

/** The console URL with its query token stripped, i.e. an anonymous caller. */
function anonymous(
	handle: DaemonHandle,
	path = "/",
	base = handle.consoleUrl,
): URL {
	const url = new URL(path, base);
	url.search = "";
	return url;
}

describe("boot trust model logging", () => {
	test("names remote trust model exactly once", async () => {
		const { messages } = await boot({ OMA_REMOTE: "1", OMA_CONSOLE: "0" });
		expect(
			messages.filter((message) => message.startsWith("trust model: ")),
		).toEqual(["trust model: remote"]);
	});

	test("names loopback trust model exactly once", async () => {
		const { messages } = await boot({ OMA_CONSOLE: "0" });
		expect(
			messages.filter((message) => message.startsWith("trust model: ")),
		).toEqual(["trust model: loopback"]);
	});
});

async function control(
	socketPath: string,
	token?: string,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
	const response = await fetch("http://localhost/rpc", {
		unix: socketPath,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "status",
			params: {},
		}),
	});
	return (await response.json()) as JsonRpcSuccess | JsonRpcFailure;
}

/**
 * A control call naming its own method, for cases where `status` — which is
 * operator-only — is the wrong probe. A worker bearer's success has to be
 * asserted on a method workers may actually call.
 */
async function controlCall(
	socketPath: string,
	method: string,
	params: unknown,
	token?: string,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
	const response = await fetch("http://localhost/rpc", {
		unix: socketPath,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
	});
	return (await response.json()) as JsonRpcSuccess | JsonRpcFailure;
}

// ── Bullet 1: the bind refusal is unconditional ──────────────────────────────

describe("bind-address config refused unconditionally", () => {
	test("refuses every listener's routable address, before anything opens", async () => {
		// The credential gateway is on this list deliberately: it is
		// loopback-always and never joins remote auth, so asking it to move is
		// refused by the same gate as the other two.
		for (const variable of [
			"OMA_CONSOLE_HOST",
			"OMA_CONTROL_HOST",
			"OMA_CREDENTIAL_GATEWAY_HOST",
		]) {
			const agentDir = await tempDir();
			const attempt = bootDaemon({
				env: { OMA_REMOTE: "1", OMA_CONSOLE: "0", [variable]: "0.0.0.0" },
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
			});
			await expect(attempt).rejects.toThrow(variable);
			await expect(attempt).rejects.toThrow("0.0.0.0");
			// Nothing opened and nothing was claimed: the refusal ran before the
			// pidfile, so a refused boot leaves no debris to clean up by hand.
			expect(
				await Bun.file(join(agentDir, "oh-my-agent", "daemon.pid")).exists(),
			).toBe(false);
		}
	});

	test("refuses a routable address with the flag off, too", async () => {
		const agentDir = await tempDir();
		await expect(
			bootDaemon({
				env: { OMA_CONSOLE_HOST: "0.0.0.0" },
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
			}),
		).rejects.toThrow("OMA_CONSOLE_HOST");
	});

	test("names the variable and the address on stderr, not just in the throw", async () => {
		// The acceptance clause is "with the reason on stderr", and stderr is
		// the only channel that carries it: `bootDaemon`'s `logger` defaults to
		// a no-op, so an operator who called it directly would otherwise get a
		// rejection and nothing to read.
		const written: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				written.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			},
		);
		try {
			await expect(
				bootDaemon({
					env: { OMA_CONTROL_HOST: "192.0.2.10" },
					agentDir: await tempDir(),
					projectDir: await tempDir(),
					workerFactory: stubWorkerFactory,
				}),
			).rejects.toThrow();
		} finally {
			spy.mockRestore();
		}
		const stderr = written.join("");
		expect(stderr).toContain("OMA_CONTROL_HOST");
		expect(stderr).toContain("192.0.2.10");
	});

	test("a loopback address is not a routable one", async () => {
		const { handle } = await boot({
			OMA_CONSOLE_HOST: "127.0.0.1",
			OMA_CONTROL_HOST: "localhost",
		});
		expect(new URL(handle.consoleUrl as string).hostname).toBe("127.0.0.1");
	});
});

// ── Bullet 2: remote mode requires the operator token ────────────────────────

describe("remote mode authentication", () => {
	test("token required for remote console requests", async () => {
		const { handle, localUrl } = await bootRemoteConsole();
		expect(handle.consoleUrl).toBeString();
		expect((await fetch(anonymous(handle, "/", localUrl))).status).toBe(401);
		expect(
			(await fetch(anonymous(handle, "/api/agents", localUrl))).status,
		).toBe(401);
	});

	test("refuses an unauthenticated control connection", async () => {
		const { handle } = await boot({ OMA_REMOTE: "1", OMA_CONSOLE: "0" });
		const answer = await control(handle.socketPath);
		expect(answer).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});

	test("refuses a control connection presenting the wrong token", async () => {
		const { handle } = await boot({ OMA_REMOTE: "1", OMA_CONSOLE: "0" });
		const answer = await control(handle.socketPath, "not-the-operator-token");
		expect(answer).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});
});

// ── Bullet 3: the token file's mode is verified at boot ──────────────────────

describe("operator token file permissions", () => {
	test("refuses a token file whose mode is not exactly 0600", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await Bun.write(join(stateDir, "console-token"), "operator-token");
		await chmod(join(stateDir, "console-token"), 0o640);
		await expect(
			bootDaemon({
				env: { OMA_REMOTE: "1", OMA_CONSOLE: "0" },
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
			}),
		).rejects.toThrow(/console-token.*640.*0600/);
		// Refused in the preflight, so no pidfile and no listener preceded it.
		expect(await Bun.file(join(stateDir, "daemon.pid")).exists()).toBe(false);
	});

	test("refuses a loose token file on the loopback default too", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await Bun.write(join(stateDir, "console-token"), "operator-token");
		await chmod(join(stateDir, "console-token"), 0o644);
		await expect(
			bootDaemon({
				env: {},
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
			}),
		).rejects.toThrow(/console-token.*644.*0600/);
	});

	test("mints the proxy secret at 0600 in remote mode", async () => {
		const { stateDir } = await boot({ OMA_REMOTE: "1", OMA_CONSOLE: "0" });
		const path = join(stateDir, "console-proxy-secret");
		expect(await Bun.file(path).exists()).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("refuses a proxy secret file whose mode is not exactly 0600", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await Bun.write(join(stateDir, "console-proxy-secret"), "proxy-secret");
		await chmod(join(stateDir, "console-proxy-secret"), 0o666);
		await expect(
			bootDaemon({
				env: { OMA_REMOTE: "1", OMA_CONSOLE: "0" },
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
			}),
		).rejects.toThrow(/console-proxy-secret.*666.*0600/);
	});
});

// ── Bullet 4: forged forwarded identity buys nothing ─────────────────────────
describe("forwarded request URL normalization", () => {
	const direct = new URL("http://127.0.0.1:4210/api/agents?view=active");
	const proxySecret = "proxy-secret";

	test("uses first valid forwarded scheme and host with the proxy secret", () => {
		const normalized = normalizeRequestUrl(
			direct,
			new Headers({
				"X-OMA-Proxy-Secret": proxySecret,
				"X-Forwarded-Proto": "https, http",
				"X-Forwarded-Host": "console.example.com:8443, internal.example",
			}),
			true,
			proxySecret,
		);
		expect(normalized.href).toBe(
			"https://console.example.com:8443/api/agents?view=active",
		);
	});

	test("ignores forwarded values without a matching proxy secret", () => {
		for (const presented of [undefined, "wrong-proxy-secret"]) {
			const headers = new Headers({
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Host": "console.example.com",
			});
			if (presented !== undefined) {
				headers.set("X-OMA-Proxy-Secret", presented);
			}
			expect(normalizeRequestUrl(direct, headers, true, proxySecret)).toBe(
				direct,
			);
		}
	});

	test("falls back to direct URL for malformed trusted values", () => {
		for (const forwarded of [
			{ "X-Forwarded-Proto": "ftp", "X-Forwarded-Host": "example.com" },
			{ "X-Forwarded-Proto": "https", "X-Forwarded-Host": "" },
			{ "X-Forwarded-Proto": "https", "X-Forwarded-Host": "bad host" },
			{ "X-Forwarded-Proto": "https", "X-Forwarded-Host": "host:" },
		]) {
			expect(
				normalizeRequestUrl(
					direct,
					new Headers({
						"X-OMA-Proxy-Secret": proxySecret,
						...forwarded,
					}),
					true,
					proxySecret,
				),
			).toBe(direct);
		}
	});

	test("loopback mode ignores forwarded scheme and host", () => {
		expect(
			normalizeRequestUrl(
				direct,
				new Headers({
					"X-OMA-Proxy-Secret": proxySecret,
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "console.example.com",
				}),
				false,
				proxySecret,
			),
		).toBe(direct);
	});
});

describe("external console origin", () => {
	test("persists and returns the configured HTTPS origin without the operator token", async () => {
		const announced: Array<string | undefined> = [];
		const agentDir = await tempDir();
		const handle = await bootDaemon({
			env: {
				OMA_REMOTE: "1",
				OMA_CONSOLE_ORIGIN: "https://console.example.com:8443",
			},
			agentDir,
			projectDir: await tempDir(),
			workerFactory: stubWorkerFactory,
			announce: (url) => announced.push(url),
		});
		cleanups.push(() => handle.close());

		expect(handle.consoleUrl).toBe("https://console.example.com:8443/");
		expect(announced).toEqual([handle.consoleUrl]);
		expect(
			await readFile(join(agentDir, "oh-my-agent", "console-url"), "utf8"),
		).toBe(handle.consoleUrl as string);
		expect(handle.consoleUrl).not.toContain("token=");
		const stdout: string[] = [];
		expect(
			await runCli(["console"], {
				agentDir,
				io: {
					stdout: (text) => stdout.push(text),
					stderr: () => {},
				},
			}),
		).toBe(0);
		expect(stdout.join("").trim()).toBe(handle.consoleUrl as string);
	});

	test("refuses malformed or unsafe external origins before claiming the daemon", async () => {
		for (const origin of [
			"http://console.example.com",
			"https://user:pass@console.example.com",
			"https://console.example.com/?tenant=one",
			"https://console.example.com/#rooms",
			"not a URL",
		]) {
			const agentDir = await tempDir();
			await expect(
				bootDaemon({
					env: { OMA_REMOTE: "1", OMA_CONSOLE_ORIGIN: origin },
					agentDir,
					projectDir: await tempDir(),
					workerFactory: stubWorkerFactory,
				}),
			).rejects.toThrow(/OMA_CONSOLE_ORIGIN/);
			expect(
				await Bun.file(join(agentDir, "oh-my-agent", "daemon.pid")).exists(),
			).toBe(false);
		}
	});

	test("refuses a missing or empty external origin before pidfile or listeners", async () => {
		for (const env of [
			{ OMA_REMOTE: "1" },
			{ OMA_REMOTE: "1", OMA_CONSOLE_ORIGIN: "" },
		]) {
			const agentDir = await tempDir();
			const serve = spyOn(Bun, "serve");
			try {
				await expect(
					bootDaemon({
						env,
						agentDir,
						projectDir: await tempDir(),
						workerFactory: stubWorkerFactory,
					}),
				).rejects.toThrow(/OMA_CONSOLE_ORIGIN/);
				expect(serve).not.toHaveBeenCalled();
			} finally {
				serve.mockRestore();
			}
			expect(
				await Bun.file(join(agentDir, "oh-my-agent", "daemon.pid")).exists(),
			).toBe(false);
		}
	});

	test("a headless remote daemon starts without an external origin", async () => {
		const { handle } = await boot({
			OMA_REMOTE: "1",
			OMA_CONSOLE: "0",
			OMA_CONSOLE_ORIGIN: undefined,
		});
		expect(handle.consoleUrl).toBeUndefined();
	});

	test("forged forwarded headers cannot replace the persisted console URL", async () => {
		const { handle, stateDir, localUrl } = await bootRemoteConsole();
		const original = handle.consoleUrl as string;
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();
		await fetch(anonymous(handle, "/api/agents", localUrl), {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Host": "forged.example.com",
			},
		});

		expect(handle.consoleUrl).toBe(original);
		expect(await readFile(join(stateDir, "console-url"), "utf8")).toBe(
			original,
		);
	});
});

describe("forwarded identity", () => {
	test("forged X-Forwarded-* gains nothing without the proxy secret", async () => {
		const { handle, stateDir, localUrl } = await bootRemoteConsole();
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();

		// A direct loopback caller holding the real operator token may set any
		// forwarded headers, but without the proxy secret they are ignored rather
		// than trusted as request identity.
		const forged = await fetch(anonymous(handle, "/api/agents", localUrl), {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Forwarded-For": "203.0.113.8",
				"X-Forwarded-User": "operator",
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Host": "console.example.com",
			},
		});
		expect(forged.status).toBe(200);

		const proxySecret = (
			await readFile(join(stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const authenticated = await fetch(
			anonymous(handle, "/api/agents", localUrl),
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"X-OMA-Proxy-Secret": proxySecret,
				},
			},
		);
		expect(authenticated.status).toBe(200);
	});

	test("a wrong proxy secret leaves forwarded headers untrusted", async () => {
		const { handle, stateDir, localUrl } = await bootRemoteConsole();
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();
		const response = await fetch(anonymous(handle, "/api/agents", localUrl), {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-OMA-Proxy-Secret": "not-the-proxy-secret",
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Host": "console.example.com",
			},
		});
		expect(response.status).toBe(200);
	});

	test("the proxy secret alone, without the operator token, is refused", async () => {
		const { handle, stateDir, localUrl } = await bootRemoteConsole();
		const proxySecret = (
			await readFile(join(stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const response = await fetch(anonymous(handle, "/api/agents", localUrl), {
			headers: { "X-OMA-Proxy-Secret": proxySecret },
		});
		expect(response.status).toBe(401);
	});
});

// ── Bullet 5: the loopback default is unchanged ──────────────────────────────

describe("loopback default", () => {
	test("serves the console on the token alone, with no proxy secret", async () => {
		const { handle, stateDir } = await boot();
		expect(new URL(handle.consoleUrl as string).hostname).toBe("127.0.0.1");
		// The announced URL carries the token and works as it always has.
		expect((await fetch(handle.consoleUrl as string)).status).toBe(200);
		expect(new URL(handle.consoleUrl as string).searchParams.get("token")).toBe(
			(await readFile(join(stateDir, "console-token"), "utf8")).trim(),
		);

		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();
		const api = await fetch(anonymous(handle, "/api/agents"), {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(api.status).toBe(200);
	});

	test("mints no proxy secret when remote mode is off", async () => {
		const { stateDir } = await boot();
		expect(
			await Bun.file(join(stateDir, "console-proxy-secret")).exists(),
		).toBe(false);
	});

	test("still refuses an unauthenticated console request", async () => {
		const { handle } = await boot();
		expect((await fetch(anonymous(handle, "/api/agents"))).status).toBe(401);
	});

	test("answers the control socket for the operator token", async () => {
		const { handle, stateDir } = await boot();
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();
		expect(await control(handle.socketPath, token)).toHaveProperty("result");
	});

	test("reuses a stored 0600 token across boots", async () => {
		const agentDir = await tempDir();
		const { handle: first, stateDir } = await boot({}, agentDir);
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();
		await first.close();

		const { handle: second } = await boot({}, agentDir);
		expect(
			(await readFile(join(stateDir, "console-token"), "utf8")).trim(),
		).toBe(token);
		expect(await control(second.socketPath, token)).toHaveProperty("result");
	});
});

// ── T-1201: the control socket's bearer contract, over a real boot ───────────

/**
 * `bootDaemon` composes the control socket with its own `remoteMode`, and
 * these drive that composition rather than a hand-built listener — so unlike
 * the harness suite in `socket-identity.test.ts`, these observe the flag
 * travelling from `OMA_REMOTE=1` through `./main` to the listener's decision.
 *
 * The contract, per ADR-012: a registered bearer is required in both modes;
 * the operator surface additionally requires the operator token specifically
 * in remote mode (clause (a)); and a worker's scoped token keeps its own
 * `workerMethods` surface in both (clause (b), T-1004), because T-1204's
 * parentage enforcement is defined over the identity that resolves here.
 */
describe("remote mode control-socket hierarchy enforced", () => {
	/** A peer definition, so a real boot mints a scoped worker token. */
	async function writePeer(agentDir: string): Promise<void> {
		const root = join(agentDir, "oh-my-agent", "agents");
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "reviewer.md"),
			'---\nname: "reviewer"\ndescription: "Reviews."\nmodel: "openai/gpt-4.1"\nspawns: "*"\nrooms: ["#general"]\n---\nReview.\n',
			"utf8",
		);
	}

	/**
	 * Boot with a peer, capturing the worker bearer the daemon issued. The
	 * factory is the only place that credential is visible, which is the point:
	 * a worker's token never lands on disk.
	 */
	async function bootWithWorker(
		env: Record<string, string | undefined>,
	): Promise<{ handle: DaemonHandle; operator: string; worker: string }> {
		const agentDir = await tempDir();
		await writePeer(agentDir);
		const workerTokens: string[] = [];
		const handle = await bootDaemon({
			env: withRemoteConsoleOrigin(env),
			agentDir,
			projectDir: await tempDir(),
			workerFactory: async (options) => {
				workerTokens.push(options.controlToken);
				return await stubWorkerFactory(options);
			},
		});
		cleanups.push(() => handle.close());
		const operator = (
			await readFile(join(agentDir, "oh-my-agent", "console-token"), "utf8")
		).trim();
		const worker = workerTokens[0] as string;
		expect(worker).toBeString();
		return { handle, operator, worker };
	}

	test("answers the operator token in remote mode", async () => {
		const { handle, operator } = await bootWithWorker({
			OMA_REMOTE: "1",
			OMA_CONSOLE: "0",
		});
		expect(await control(handle.socketPath, operator)).toHaveProperty("result");
	});

	test("refuses an unauthenticated control connection in remote mode", async () => {
		const { handle } = await bootWithWorker({
			OMA_REMOTE: "1",
			OMA_CONSOLE: "0",
		});
		expect(await control(handle.socketPath)).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});

	test("refuses an unregistered bearer in remote mode", async () => {
		const { handle } = await bootWithWorker({
			OMA_REMOTE: "1",
			OMA_CONSOLE: "0",
		});
		expect(
			await control(handle.socketPath, "not-a-registered-token"),
		).toMatchObject({ error: { code: ERROR_CODE.UNAUTHORIZED } });
	});

	test("a scoped worker token keeps its own surface in remote mode", async () => {
		const { handle, worker } = await bootWithWorker({
			OMA_REMOTE: "1",
			OMA_CONSOLE: "0",
		});
		// Clause (b) first: a worker-callable method succeeds on the worker's
		// own bearer over a real boot. Refusing everything would satisfy
		// clause (a) without any worker on this socket still working, so the
		// success is the load-bearing half of this assertion.
		expect(
			await controlCall(
				handle.socketPath,
				"chat_read",
				{ room: "#general" },
				worker,
			),
		).toHaveProperty("result");
		// Clause (a) second: `status` is operator-only, and in remote mode the
		// worker bearer is refused as a caller that did not present the
		// operator token — the same declared shape a missing bearer gets.
		expect(await control(handle.socketPath, worker)).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});

	test("remote worker spawn parent must match its authenticated identity", async () => {
		const { handle, worker } = await bootWithWorker({
			OMA_REMOTE: "1",
			OMA_CONSOLE: "0",
		});
		for (const params of [
			{ name: "reviewer" },
			{ name: "reviewer", parent: "someone-else" },
		]) {
			expect(
				await controlCall(handle.socketPath, "agent_spawn", params, worker),
			).toMatchObject({ error: { code: ERROR_CODE.FORBIDDEN } });
		}
		// Self-parentage passes the identity gate, then ordinary hierarchy
		// validation rejects the cycle. A blanket refusal would return forbidden.
		expect(
			await controlCall(
				handle.socketPath,
				"agent_spawn",
				{ name: "reviewer", parent: "reviewer" },
				worker,
			),
		).toMatchObject({ error: { code: ERROR_CODE.INVALID_PARAMS } });
	});

	test("the loopback default differs only in that one refusal", async () => {
		// The control for the remote-mode cases above, asserted on the same
		// methods with the same bearers. The pair is what isolates the flag's
		// effect to exactly one cell of the matrix: every assertion here
		// matches its remote counterpart except the worker-on-operator-method
		// refusal, which is `forbidden` on loopback and `unauthorized` in
		// remote mode. That difference is ADR-012 clause (a); the identical
		// worker success below it is clause (b).
		const { handle, operator, worker } = await bootWithWorker({});
		expect(await control(handle.socketPath, operator)).toHaveProperty("result");
		expect(
			await controlCall(
				handle.socketPath,
				"chat_read",
				{ room: "#general" },
				worker,
			),
		).toHaveProperty("result");
		expect(await control(handle.socketPath, worker)).toMatchObject({
			error: { code: ERROR_CODE.FORBIDDEN },
		});
		expect(
			await control(handle.socketPath, "not-a-registered-token"),
		).toMatchObject({ error: { code: ERROR_CODE.UNAUTHORIZED } });
		expect(await control(handle.socketPath)).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});
});

interface AuditConnection {
	identity: string;
	class: string;
	source: string;
	connectedAt: string;
}

interface AuditOutput {
	trustModel: "loopback" | "remote";
	connections: AuditConnection[];
}

async function auditCli(agentDir: string): Promise<AuditOutput> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runCli(["--json", "audit"], {
		agentDir,
		io: {
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		},
	});
	expect(code).toBe(0);
	expect(stderr).toEqual([]);
	return JSON.parse(stdout.join("")) as AuditOutput;
}

async function openRemoteConsoleSocket(
	booted: Booted & { localUrl: string },
	operatorToken: string,
	proxySecret: string,
	forwardedFor?: string,
): Promise<{ socket: WebSocket; ticket: string }> {
	const forwarded = {
		"X-OMA-Proxy-Secret": proxySecret,
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host": "console.example.com",
		...(forwardedFor === undefined ? {} : { "X-Forwarded-For": forwardedFor }),
	};
	const ticketResponse = await fetch(
		anonymous(booted.handle, "/api/ws-ticket", booted.localUrl),
		{
			method: "POST",
			headers: {
				...forwarded,
				Authorization: `Bearer ${operatorToken}`,
			},
		},
	);
	expect(ticketResponse.status).toBe(200);
	const { ticket } = (await ticketResponse.json()) as { ticket: string };
	const events = new URL("/api/events", booted.localUrl);
	events.protocol = "ws:";
	events.searchParams.set("ticket", ticket);
	const socket = new WebSocket(events.href, { headers: forwarded });
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("socket error")), {
			once: true,
		});
	});
	return { socket, ticket };
}

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	await new Promise<void>((resolve) => {
		socket.addEventListener("close", () => resolve(), { once: true });
		socket.close();
	});
}

describe("remote console ticket authentication", () => {
	test("enforces token minting, path binding, 30-second lifetime, and one-time use", async () => {
		let now = 1_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const booted = await bootRemoteConsole();
			const operatorToken = (
				await readFile(join(booted.stateDir, "console-token"), "utf8")
			).trim();
			const proxySecret = (
				await readFile(join(booted.stateDir, "console-proxy-secret"), "utf8")
			).trim();
			const forwarded = {
				"X-OMA-Proxy-Secret": proxySecret,
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Host": "console.example.com",
			};
			const mint = async (endpoint: "/api/session" | "/api/ws-ticket") => {
				const response = await fetch(
					anonymous(booted.handle, endpoint, booted.localUrl),
					{
						method: "POST",
						headers: {
							...forwarded,
							Authorization: `Bearer ${operatorToken}`,
						},
					},
				);
				expect(response.status).toBe(200);
				const body: unknown = await response.json();
				if (
					typeof body !== "object" ||
					body === null ||
					!("ticket" in body) ||
					typeof body.ticket !== "string"
				) {
					throw new Error("Ticket response carried no ticket");
				}
				return body.ticket;
			};
			const use = (path: string, ticket: string) => {
				const url = anonymous(booted.handle, path, booted.localUrl);
				url.searchParams.set("ticket", ticket);
				return fetch(url, { headers: forwarded });
			};

			expect(
				(
					await fetch(
						anonymous(booted.handle, "/api/session", booted.localUrl),
						{ method: "POST", headers: forwarded },
					)
				).status,
			).toBe(401);

			const wrongPath = await mint("/api/session");
			expect((await use("/style.css", wrongPath)).status).toBe(401);
			expect((await use("/", wrongPath)).status).toBe(401);

			const boundary = await mint("/api/session");
			now += 30_000;
			const shell = await use("/", boundary);
			expect(shell.status).toBe(200);
			expect((await use("/", boundary)).status).toBe(401);
			const html = await shell.text();
			const style = /href="(\/style\.css\?ticket=[^"]+)"/.exec(html)?.[1];
			const script = /src="(\/app\.js\?ticket=[^"]+)"/.exec(html)?.[1];
			if (style === undefined || script === undefined) {
				throw new Error("Authenticated shell carried no asset tickets");
			}
			expect(
				(
					await fetch(new URL(style, booted.localUrl), {
						headers: forwarded,
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(new URL(style, booted.localUrl), {
						headers: forwarded,
					})
				).status,
			).toBe(401);
			expect(
				(
					await fetch(new URL(script, booted.localUrl), {
						headers: forwarded,
					})
				).status,
			).toBe(200);

			const expired = await mint("/api/session");
			now += 30_001;
			expect((await use("/", expired)).status).toBe(401);

			const wrongPathWsTicket = await mint("/api/ws-ticket");
			expect((await use("/", wrongPathWsTicket)).status).toBe(401);
			expect((await use("/api/events", wrongPathWsTicket)).status).toBe(401);

			const wsTicket = await mint("/api/ws-ticket");
			const events = new URL("/api/events", booted.localUrl);
			events.protocol = "ws:";
			events.searchParams.set("ticket", wsTicket);
			const socket = new WebSocket(events.href, { headers: forwarded });
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener(
					"error",
					() => reject(new Error("socket error")),
					{ once: true },
				);
			});
			await closeSocket(socket);
			expect((await use("/api/events", wsTicket)).status).toBe(401);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("authenticated connection audit", () => {
	test("loopback audit changes no persisted listener state", async () => {
		const { stateDir } = await boot();
		expect(await auditCli(join(stateDir, ".."))).toEqual({
			trustModel: "loopback",
			connections: [],
		});
		expect(
			await Bun.file(join(stateDir, "connection-audit.json")).exists(),
		).toBe(false);
		const stdout: string[] = [];
		expect(
			await runCli(["audit"], {
				agentDir: join(stateDir, ".."),
				io: { stdout: (text) => stdout.push(text), stderr: () => {} },
			}),
		).toBe(0);
		expect(stdout.join("")).toBe("trust model: loopback\nconnections: 0\n");
	});

	test("records truthful sources without trusting unauthenticated forwarding", async () => {
		const booted = await bootRemoteConsole();
		const operatorToken = (
			await readFile(join(booted.stateDir, "console-token"), "utf8")
		).trim();
		const proxySecret = (
			await readFile(join(booted.stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const written: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				written.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			},
		);
		try {
			expect(
				await control(booted.handle.socketPath, operatorToken),
			).toHaveProperty("result");
			const direct = await fetch(
				anonymous(booted.handle, "/api/agents", booted.localUrl),
				{
					headers: {
						Authorization: `Bearer ${operatorToken}`,
						"X-Forwarded-For": "198.51.100.9",
					},
				},
			);
			expect(direct.status).toBe(200);
			const proxied = await fetch(
				anonymous(booted.handle, "/api/agents", booted.localUrl),
				{
					headers: {
						Authorization: `Bearer ${operatorToken}`,
						"X-OMA-Proxy-Secret": proxySecret,
						"X-Forwarded-For": "203.0.113.8, 127.0.0.1",
						"X-Forwarded-Proto": "https",
						"X-Forwarded-Host": "console.example.com",
					},
				},
			);
			expect(proxied.status).toBe(200);
			const { socket } = await openRemoteConsoleSocket(
				booted,
				operatorToken,
				proxySecret,
				"203.0.113.8",
			);
			const live = await auditCli(join(booted.stateDir, ".."));
			expect(live.connections).toEqual([
				expect.objectContaining({
					identity: "operator",
					class: "console-proxied",
					source: "203.0.113.8",
				}),
			]);
			await closeSocket(socket);
		} finally {
			stderr.mockRestore();
		}

		const connects = written
			.join("")
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("audit: "))
			.map(
				(line) =>
					JSON.parse(line.slice("audit: ".length)) as Record<string, string>,
			)
			.filter((record) => record.event === "connect");
		expect(
			connects.some((record) => record.source === booted.handle.socketPath),
		).toBe(true);
		expect(connects.some((record) => record.source === "198.51.100.9")).toBe(
			false,
		);
		expect(connects.some((record) => record.source === "203.0.113.8")).toBe(
			true,
		);
		expect(
			connects.some((record) =>
				/^(?:127\.0\.0\.1|::1)$/.test(record.source ?? ""),
			),
		).toBe(true);
		for (const record of connects)
			expect(Date.parse(record.at as string)).not.toBeNaN();
		const text = written.join("");
		expect(text).not.toContain(operatorToken);
		expect(text).not.toContain(proxySecret);
	});

	test("does not use the predictable legacy audit temporary name", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await mkdir(stateDir, { recursive: true });
		const victim = join(agentDir, "victim");
		await writeFile(victim, "untouched", { mode: 0o600 });
		const auditPath = join(stateDir, "connection-audit.json");
		await symlink(victim, `${auditPath}.${process.pid}.0.tmp`);

		persistConnectionAuditState(auditPath, "audit-state");
		expect(await readFile(victim, "utf8")).toBe("untouched");
		expect(await readFile(auditPath, "utf8")).toBe("audit-state");
		expect(statSync(auditPath).mode & 0o777).toBe(0o600);
	});

	test("refuses an audit temporary symlink collision", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await mkdir(stateDir, { recursive: true });
		const victim = join(agentDir, "victim");
		await writeFile(victim, "untouched", { mode: 0o600 });
		const auditPath = join(stateDir, "connection-audit.json");
		await symlink(victim, `${auditPath}.fixed.tmp`);

		expect(() =>
			persistConnectionAuditState(auditPath, "audit-state", "fixed"),
		).toThrow();
		expect(await readFile(victim, "utf8")).toBe("untouched");
	});

	test("refuses an existing audit temporary file", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await mkdir(stateDir, { recursive: true });
		const auditPath = join(stateDir, "connection-audit.json");
		const temporary = `${auditPath}.fixed.tmp`;
		await writeFile(temporary, "attacker-content", { mode: 0o644 });

		expect(() =>
			persistConnectionAuditState(auditPath, "audit-state", "fixed"),
		).toThrow();
		expect(await readFile(temporary, "utf8")).toBe("attacker-content");
		expect(statSync(temporary).mode & 0o777).toBe(0o644);
	});

	test("refuses audit persistence in an unsafe state directory", async () => {
		const agentDir = await tempDir();
		const stateDir = join(agentDir, "oh-my-agent");
		await mkdir(stateDir, { recursive: true });
		await chmod(stateDir, 0o770);

		await expect(
			bootDaemon({
				env: withRemoteConsoleOrigin({ OMA_REMOTE: "1", OMA_CONSOLE: "0" }),
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
				logger: () => {},
			}),
		).rejects.toThrow("unsafe audit state directory");
		expect(
			await Bun.file(join(stateDir, "connection-audit.json")).exists(),
		).toBe(false);
	});

	test("logs authenticated session, websocket-ticket, and static connections", async () => {
		const booted = await bootRemoteConsole();
		const operatorToken = (
			await readFile(join(booted.stateDir, "console-token"), "utf8")
		).trim();
		const proxySecret = (
			await readFile(join(booted.stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const forwarded = {
			"X-OMA-Proxy-Secret": proxySecret,
			"X-Forwarded-Proto": "https",
			"X-Forwarded-Host": "console.example.com",
		};
		const written: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				written.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			},
		);
		let ticket = "";
		try {
			const session = await fetch(
				anonymous(booted.handle, "/api/session", booted.localUrl),
				{
					method: "POST",
					headers: {
						...forwarded,
						Authorization: `Bearer ${operatorToken}`,
					},
				},
			);
			expect(session.status).toBe(200);
			const sessionBody: unknown = await session.json();
			if (
				typeof sessionBody !== "object" ||
				sessionBody === null ||
				!("ticket" in sessionBody) ||
				typeof sessionBody.ticket !== "string"
			) {
				throw new Error("Session response carried no ticket");
			}
			ticket = sessionBody.ticket;
			const wsTicket = await fetch(
				anonymous(booted.handle, "/api/ws-ticket", booted.localUrl),
				{
					method: "POST",
					headers: {
						...forwarded,
						Authorization: `Bearer ${operatorToken}`,
					},
				},
			);
			expect(wsTicket.status).toBe(200);
			const root = anonymous(booted.handle, "/", booted.localUrl);
			root.searchParams.set("ticket", ticket);
			expect((await fetch(root, { headers: forwarded })).status).toBe(200);
		} finally {
			stderr.mockRestore();
		}
		const records = written
			.join("")
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("audit: "));
		expect(records).toHaveLength(6);
		expect(
			records.every((line) => line.includes('"class":"console-proxied"')),
		).toBe(true);
		expect(written.join("")).not.toContain(operatorToken);
		expect(written.join("")).not.toContain(proxySecret);
		expect(written.join("")).not.toContain(ticket);
	});

	test("audit lists a live remote console and removes it on close", async () => {
		const booted = await bootRemoteConsole();
		const operatorToken = (
			await readFile(join(booted.stateDir, "console-token"), "utf8")
		).trim();
		const proxySecret = (
			await readFile(join(booted.stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const { socket, ticket } = await openRemoteConsoleSocket(
			booted,
			operatorToken,
			proxySecret,
		);

		const live = await auditCli(join(booted.stateDir, ".."));
		expect(live).toEqual({
			trustModel: "remote",
			connections: [
				{
					identity: "operator",
					class: "console-proxied",
					source: expect.any(String),
					connectedAt: expect.any(String),
				},
			],
		});
		expect(JSON.stringify(live)).not.toContain(ticket);

		await closeSocket(socket);
		expect(await auditCli(join(booted.stateDir, ".."))).toEqual({
			trustModel: "remote",
			connections: [],
		});
	});

	test("refuses a connection beyond the live audit cap before logging it", async () => {
		const booted = await bootRemoteConsole();
		const operatorToken = (
			await readFile(join(booted.stateDir, "console-token"), "utf8")
		).trim();
		const proxySecret = (
			await readFile(join(booted.stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const written: string[] = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				written.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			},
		);
		const sockets: WebSocket[] = [];
		try {
			for (let index = 0; index < 32; index += 1) {
				const opened = await openRemoteConsoleSocket(
					booted,
					operatorToken,
					proxySecret,
				);
				sockets.push(opened.socket);
			}
			written.length = 0;
			const refused = await fetch(
				anonymous(booted.handle, "/api/ws-ticket", booted.localUrl),
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${operatorToken}`,
						"X-OMA-Proxy-Secret": proxySecret,
						"X-Forwarded-For": "203.0.113.8",
						"X-Forwarded-Proto": "https",
						"X-Forwarded-Host": "console.example.com",
					},
				},
			);
			expect(refused.status).toBe(503);
			expect(written.join("")).not.toContain("audit: ");
			const persisted = JSON.parse(
				await readFile(join(booted.stateDir, "connection-audit.json"), "utf8"),
			) as { connections: AuditConnection[] };
			expect(persisted.connections).toHaveLength(32);
		} finally {
			for (const socket of sockets) await closeSocket(socket);
			stderr.mockRestore();
		}
	});
});
