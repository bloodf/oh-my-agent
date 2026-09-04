import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const COMMAND_TIMEOUT_MS = 120_000;
const EXPECTED_RPC_CLIENT_PID = "absent" as const;

function extractNpmPackMetadata(stdout: string): { filename: string } {
	// npm pack --json returns an array on older npm releases and an object
	// keyed by package name on npm 12. Prepack lifecycle logs can precede either
	// shape, so scan backward for the final valid JSON value with pack metadata.
	for (let i = stdout.length - 1; i >= 0; i--) {
		const ch = stdout[i];
		if (ch !== "[" && ch !== "{") continue;
		try {
			const parsed = JSON.parse(stdout.slice(i));
			const candidates = Array.isArray(parsed)
				? parsed
				: parsed &&
						typeof parsed === "object" &&
						typeof parsed.filename === "string"
					? [parsed]
					: parsed && typeof parsed === "object"
						? Object.values(parsed)
						: [];
			for (const candidate of candidates) {
				if (
					candidate &&
					typeof candidate === "object" &&
					typeof candidate.filename === "string"
				) {
					return { filename: candidate.filename };
				}
			}
		} catch {
			// not a valid JSON start here; keep scanning backward
		}
	}
	throw new Error(`npm pack JSON not found in stdout:\n${stdout}`);
}

type Installer = "npm" | "bun";

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(
	cmd: string[],
	cwd: string,
	env: Record<string, string>,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
	const child = Bun.spawn({
		cmd: cmd[0]?.endsWith("/node_modules/.bin/omp-agent")
			? [process.execPath, ...cmd]
			: cmd,
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	// Integration commands expose no completion event beyond process exit; this
	// deadline prevents a stalled registry or launcher from leaking the suite.
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (timedOut) {
			throw new Error(
				`command timed out after ${timeoutMs}ms: ${cmd.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`,
			);
		}
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}

async function startDaemonViaShim(
	shim: string,
	cwd: string,
	env: Record<string, string>,
	pidPath: string,
	socketPath: string,
): Promise<Bun.Subprocess> {
	const launcher = Bun.spawn({
		cmd: [process.execPath, shim, "daemon"],
		cwd,
		env,
		stdio: ["ignore", "ignore", "ignore"],
	});
	const deadline = Date.now() + 60_000;
	while (
		(!existsSync(pidPath) || !existsSync(socketPath)) &&
		Date.now() < deadline
	) {
		// Readiness belongs to detached daemon files; launcher has no event for it.
		await Bun.sleep(50);
	}
	if (!existsSync(pidPath) || !existsSync(socketPath)) {
		launcher.kill();
		await launcher.exited;
		await stopDaemon(shim, cwd, env, pidPath);
		throw new Error(
			`installed shim did not boot daemon within 60000ms: ${shim}`,
		);
	}
	return launcher;
}

function expectSuccess(result: CommandResult, command: string): void {
	expect(
		result.code,
		`${command} exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
	).toBe(0);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	// Polls OS process existence after signals; no deterministic clock can
	// replace observation of an external process exiting.
	const deadline = Date.now() + timeoutMs;
	while (alive(pid) && Date.now() < deadline) {
		await Bun.sleep(50);
	}
	return !alive(pid);
}

async function stopDaemon(
	shim: string,
	consumerDir: string,
	env: Record<string, string>,
	pidPath: string,
	knownPid?: number,
): Promise<void> {
	if (knownPid === undefined && !existsSync(pidPath)) return;
	const pid = knownPid ?? Number((await readFile(pidPath, "utf8")).trim());
	const stopped = await run(
		[shim, "daemon", "stop"],
		consumerDir,
		env,
		30_000,
	).catch(() => undefined);
	if (stopped?.code === 0 && (await waitForExit(pid, 5_000))) return;

	if (alive(pid)) process.kill(pid, "SIGTERM");
	if (await waitForExit(pid, 5_000)) return;
	process.kill(pid, "SIGKILL");
	if (!(await waitForExit(pid, 5_000))) {
		throw new Error(
			`daemon ${pid} survived installed-shim stop, SIGTERM, and SIGKILL`,
		);
	}
}

async function smokeConsumer(
	root: string,
	tarball: string,
	installer: Installer,
): Promise<void> {
	const consumerDir = join(root, installer);
	const home = join(consumerDir, ".home");
	const agentDir = join(home, ".omp", "agent");
	const cacheDir = join(root, `${installer}-cache`);
	await Promise.all([
		mkdir(consumerDir, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(cacheDir, { recursive: true }),
	]);
	await writeFile(
		join(consumerDir, "package.json"),
		JSON.stringify({
			name: `consumer-${installer}`,
			version: "0.0.0",
			private: true,
		}),
	);

	const path = process.env.PATH;
	if (!path)
		throw new Error("PATH is required to run npm, bun, and installed shims");
	const env: Record<string, string> = {
		PATH: path,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		OMP_AUTH_BROKER_URL: "",
		OMP_AUTH_BROKER_TOKEN: "",
		OMA_CONSOLE: "0",
		NO_COLOR: "1",
		npm_config_cache: cacheDir,
		npm_config_registry: "https://registry.npmjs.org/",
		BUN_INSTALL_CACHE_DIR: cacheDir,
	};
	const installCommand =
		installer === "npm"
			? [
					"npm",
					"install",
					"--no-package-lock",
					"--no-audit",
					"--no-fund",
					tarball,
				]
			: ["bun", "add", "--no-save", tarball];
	const install = await run(installCommand, consumerDir, env);
	expectSuccess(install, `${installer} consumer install`);

	for (const peer of ["pi-ai", "pi-coding-agent", "pi-utils"] as const) {
		const peerRoot = join(consumerDir, "node_modules", "@oh-my-pi", peer);
		expect(
			existsSync(join(peerRoot, "package.json")),
			`${installer} ${peer} peer missing`,
		).toBe(true);
		expect(
			(await lstat(peerRoot)).isSymbolicLink(),
			`${installer} ${peer} peer resolved as symlink instead of registry install`,
		).toBe(false);
		expect(
			(await realpath(peerRoot)).startsWith(PACKAGE_ROOT),
			`${installer} ${peer} peer resolved from package checkout`,
		).toBe(false);
	}

	const importContract = await run(
		[
			"bun",
			"--eval",
			'import "@oh-my-pi/pi-ai"; import "@oh-my-pi/pi-ai/auth-broker"; import "@oh-my-pi/pi-utils"; import "@oh-my-pi/pi-coding-agent"; import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client"; const client = new RpcClient(); if (client.pid !== undefined) throw new Error("stopped RpcClient.pid must be undefined, got " + String(client.pid)); process.stdout.write("pid" in client ? "present" : "absent");',
		],
		consumerDir,
		env,
	);
	expectSuccess(importContract, `${installer} resolved-peer import probe`);
	expect(importContract.stdout, `${installer} RpcClient.pid contract`).toBe(
		EXPECTED_RPC_CLIENT_PID,
	);

	const shim = join(consumerDir, "node_modules", ".bin", "omp-agent");
	expect(existsSync(shim), `${installer} installed shim missing`).toBe(true);

	const stateDir = join(agentDir, "oh-my-agent");
	const pidPath = join(stateDir, "daemon.pid");
	const socketPath = join(stateDir, "daemon.sock");
	let launcher: Bun.Subprocess | undefined;
	let daemonPid: number | undefined;
	try {
		const down = await run([shim, "status"], consumerDir, env, 30_000);
		expect(
			down.code,
			`${installer} installed-shim down status: ${down.stderr}`,
		).toBe(3);

		launcher = await startDaemonViaShim(
			shim,
			consumerDir,
			env,
			pidPath,
			socketPath,
		);
		expect(existsSync(pidPath), `${installer} daemon pidfile missing`).toBe(
			true,
		);
		daemonPid = Number((await readFile(pidPath, "utf8")).trim());
		expect(existsSync(socketPath), `${installer} daemon socket missing`).toBe(
			true,
		);

		const status = await run([shim, "status"], consumerDir, env, 30_000);
		expectSuccess(status, `${installer} installed-shim daemon status`);
		expect(status.stdout).toContain("protocol:");
	} finally {
		try {
			await stopDaemon(shim, consumerDir, env, pidPath, daemonPid);
			expect(existsSync(pidPath), `${installer} daemon pidfile leaked`).toBe(
				false,
			);
			expect(existsSync(socketPath), `${installer} daemon socket leaked`).toBe(
				false,
			);
		} finally {
			launcher?.kill();
			if (launcher) await launcher.exited;
		}
	}
}

async function smokeOmpInstall(root: string, tarball: string): Promise<void> {
	const home = join(root, "omp-home");
	const agentDir = join(home, ".omp", "agent");
	const cacheDir = join(root, "omp-cache");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(cacheDir, { recursive: true }),
	]);

	const path = process.env.PATH;
	if (!path)
		throw new Error("PATH is required to locate the installed OMP executable");
	const omp = Bun.which("omp");
	if (!omp)
		throw new Error("current installed OMP executable not found on PATH");
	const env: Record<string, string> = {
		PATH: path,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		OMP_AUTH_BROKER_URL: "",
		OMP_AUTH_BROKER_TOKEN: "",
		OMA_CONSOLE: "1",
		OMA_REMOTE: "0",
		NO_COLOR: "1",
		npm_config_cache: cacheDir,
		npm_config_registry: "https://registry.npmjs.org/",
		BUN_INSTALL_CACHE_DIR: cacheDir,
	};
	const installSpec = `@bloodf/oh-my-agent@file:${tarball}`;
	const install = await run([omp, "install", installSpec], home, env);
	expectSuccess(install, `omp install ${installSpec}`);

	const pluginsDir = join(home, ".omp", "plugins");
	const packageRoot = join(
		pluginsDir,
		"node_modules",
		"@bloodf",
		"oh-my-agent",
	);
	const shim = join(pluginsDir, "node_modules", ".bin", "omp-agent");
	expect(
		existsSync(join(packageRoot, "package.json")),
		"OMP-installed package missing",
	).toBe(true);
	expect(existsSync(shim), "OMP-installed shim missing").toBe(true);

	const stateDir = join(agentDir, "oh-my-agent");
	const pidPath = join(stateDir, "daemon.pid");
	const socketPath = join(stateDir, "daemon.sock");
	let launcher: Bun.Subprocess | undefined;
	let daemonPid: number | undefined;
	try {
		const down = await run([shim, "status"], home, env, 30_000);
		expect(down.code, `OMP-installed shim down status: ${down.stderr}`).toBe(3);

		launcher = await startDaemonViaShim(shim, home, env, pidPath, socketPath);
		daemonPid = Number((await readFile(pidPath, "utf8")).trim());

		const status = await run([shim, "status"], home, env, 30_000);
		expectSuccess(status, "OMP-installed shim daemon status");
		expect(status.stdout).toContain("protocol:");

		const consoleResult = await run([shim, "console"], home, env, 30_000);
		expectSuccess(consoleResult, "OMP-installed shim console");
		const consoleUrl = new URL(consoleResult.stdout.trim());
		expect(consoleUrl.protocol).toBe("http:");
		expect(["127.0.0.1", "localhost"]).toContain(consoleUrl.hostname);
		expect(Number(consoleUrl.port)).toBeGreaterThan(0);
		const shell = await fetch(consoleUrl);
		expect(shell.ok, `console shell returned ${shell.status}`).toBe(true);
	} finally {
		try {
			await stopDaemon(shim, home, env, pidPath, daemonPid);
			expect(existsSync(pidPath), "OMP daemon pidfile leaked").toBe(false);
			expect(existsSync(socketPath), "OMP daemon socket leaked").toBe(false);
		} finally {
			launcher?.kill();
			if (launcher) await launcher.exited;
		}
	}
}

test("packed package installs with fresh npm, bun, and OMP consumers and boots through each installed shim", async () => {
	const root = await mkdtemp(join(tmpdir(), "oma-consumer-install-"));
	try {
		let tarball: string;
		const suppliedTarball = process.env.OMA_PACKED_TARBALL;
		if (suppliedTarball) {
			tarball = resolve(suppliedTarball);
		} else {
			const packDir = join(root, "pack");
			await mkdir(packDir);
			const pack = await run(
				["npm", "pack", "--json", "--silent", "--pack-destination", packDir],
				PACKAGE_ROOT,
				{
					PATH: process.env.PATH ?? "",
					HOME: join(root, "pack-home"),
					NO_COLOR: "1",
				},
			);
			expectSuccess(pack, "npm pack");
			const { filename } = extractNpmPackMetadata(pack.stdout);
			tarball = join(packDir, filename);
		}
		expect(existsSync(tarball), `${tarball} missing`).toBe(true);

		for (const installer of ["npm", "bun"] as const) {
			await smokeConsumer(root, tarball, installer);
		}
		await smokeOmpInstall(root, tarball);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 600_000);
