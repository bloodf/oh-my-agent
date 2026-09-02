/**
 * T-1201: the remote-mode surface and the unconditional bind refusal.
 *
 * The five acceptance bullets, one describe each: no listener ever answers a
 * routable address; remote mode demands the operator token on both surfaces;
 * the operator token file's mode is verified before anything opens; forged
 * `X-Forwarded-*` buys nothing without the per-install proxy secret; and the
 * loopback default behaves exactly as it did before this task.
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
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonHandle, WorkerFactory } from "../src/daemon/main";
import { bootDaemon } from "../src/daemon/main";
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
}

async function boot(
	env: Record<string, string | undefined> = {},
	agentDir?: string,
): Promise<Booted> {
	const dir = agentDir ?? (await tempDir());
	const handle = await bootDaemon({
		env,
		agentDir: dir,
		projectDir: await tempDir(),
		workerFactory: stubWorkerFactory,
	});
	cleanups.push(() => handle.close());
	return { handle, stateDir: join(dir, "oh-my-agent") };
}

/** The console URL with its query token stripped, i.e. an anonymous caller. */
function anonymous(handle: DaemonHandle, path = "/"): URL {
	const url = new URL(path, handle.consoleUrl);
	url.search = "";
	return url;
}

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

describe("routable bind refusal", () => {
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
				env: { OMA_REMOTE: "1", [variable]: "0.0.0.0" },
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
	test("refuses an unauthenticated console request", async () => {
		const { handle } = await boot({ OMA_REMOTE: "1" });
		expect(handle.consoleUrl).toBeString();
		expect((await fetch(anonymous(handle))).status).toBe(401);
		expect((await fetch(anonymous(handle, "/api/agents"))).status).toBe(401);
	});

	test("refuses an unauthenticated control connection", async () => {
		const { handle } = await boot({ OMA_REMOTE: "1" });
		const answer = await control(handle.socketPath);
		expect(answer).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});

	test("refuses a control connection presenting the wrong token", async () => {
		const { handle } = await boot({ OMA_REMOTE: "1" });
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
				env: { OMA_REMOTE: "1" },
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
		const { stateDir } = await boot({ OMA_REMOTE: "1" });
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
				env: { OMA_REMOTE: "1" },
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubWorkerFactory,
			}),
		).rejects.toThrow(/console-proxy-secret.*666.*0600/);
	});
});

// ── Bullet 4: forged forwarded identity buys nothing ─────────────────────────

describe("forwarded identity", () => {
	test("forged X-Forwarded-* gains nothing without the proxy secret", async () => {
		const { handle, stateDir } = await boot({ OMA_REMOTE: "1" });
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();

		// A direct loopback caller holding the real operator token and setting
		// every forwarded header it likes: refused, because the headers are
		// anonymous client input until the proxy secret says otherwise.
		const forged = await fetch(anonymous(handle, "/api/agents"), {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Forwarded-For": "203.0.113.8",
				"X-Forwarded-User": "operator",
				"X-Forwarded-Proto": "https",
			},
		});
		expect(forged.status).toBe(401);

		const proxySecret = (
			await readFile(join(stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const authenticated = await fetch(anonymous(handle, "/api/agents"), {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-OMA-Proxy-Secret": proxySecret,
			},
		});
		expect(authenticated.status).toBe(200);
	});

	test("a wrong proxy secret is refused even with the operator token", async () => {
		const { handle, stateDir } = await boot({ OMA_REMOTE: "1" });
		const token = (
			await readFile(join(stateDir, "console-token"), "utf8")
		).trim();
		const response = await fetch(anonymous(handle, "/api/agents"), {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-OMA-Proxy-Secret": "not-the-proxy-secret",
			},
		});
		expect(response.status).toBe(401);
	});

	test("the proxy secret alone, without the operator token, is refused", async () => {
		const { handle, stateDir } = await boot({ OMA_REMOTE: "1" });
		const proxySecret = (
			await readFile(join(stateDir, "console-proxy-secret"), "utf8")
		).trim();
		const response = await fetch(anonymous(handle, "/api/agents"), {
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
describe("remote mode control-socket bearer", () => {
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
			env,
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
		const { handle, operator } = await bootWithWorker({ OMA_REMOTE: "1" });
		expect(await control(handle.socketPath, operator)).toHaveProperty("result");
	});

	test("refuses an unauthenticated control connection in remote mode", async () => {
		const { handle } = await bootWithWorker({ OMA_REMOTE: "1" });
		expect(await control(handle.socketPath)).toMatchObject({
			error: { code: ERROR_CODE.UNAUTHORIZED },
		});
	});

	test("refuses an unregistered bearer in remote mode", async () => {
		const { handle } = await bootWithWorker({ OMA_REMOTE: "1" });
		expect(
			await control(handle.socketPath, "not-a-registered-token"),
		).toMatchObject({ error: { code: ERROR_CODE.UNAUTHORIZED } });
	});

	test("a scoped worker token keeps its own surface in remote mode", async () => {
		const { handle, worker } = await bootWithWorker({ OMA_REMOTE: "1" });
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
