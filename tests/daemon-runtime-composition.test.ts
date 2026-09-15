/**
 * Composition-root paths of `bootDaemon` that only exist once the builder has
 * wired everything together: the failed-boot unwind, the console port refusal,
 * a spawn still in flight when the daemon stops, the web routes as the builder
 * composes them, and a heartbeat re-armed over the socket.
 *
 * Every boot runs against a temp agent dir with an explicit `env`, so broker
 * discovery finds nothing and embeds a broker over that dir. Workers are stubs:
 * nothing here starts an OMP process.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonHandle, WorkerFactory } from "../src/daemon/runtime";
import { bootDaemon } from "../src/daemon/runtime";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { controlCall, operatorToken } from "./fixtures/control-client";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oma-runtime-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function writePeer(
	agentDir: string,
	name: string,
	frontmatter: Record<string, unknown> = {},
): Promise<void> {
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await writeFile(
		join(agentDir, "agents", "scout.md"),
		'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
		"utf8",
	);
	const root = join(agentDir, "oh-my-agent", "agents");
	await mkdir(root, { recursive: true });
	const yaml = Object.entries({
		name,
		description: `${name} peer.`,
		model: "anthropic/claude-sonnet-4-5",
		spawns: ["scout"],
		rooms: ["#reviews"],
		...frontmatter,
	})
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	await writeFile(
		join(root, `${name}.md`),
		`---\n${yaml}\n---\nYou are ${name}.\n`,
		"utf8",
	);
}

interface Started {
	name: string;
	state: () => SupervisedWorker["state"];
	gatewayUrl: string;
}

/**
 * Stub workers, with an optional gate that holds the next start open until
 * the test releases it.
 */
function stubFactory() {
	const started: Started[] = [];
	let gate: Promise<void> | undefined;
	let entered = false;
	const factory: WorkerFactory = async ({ peer, inferenceGateway }) => {
		let state: SupervisedWorker["state"] = "running";
		started.push({
			name: peer.name,
			state: () => state,
			gatewayUrl: inferenceGateway.url,
		});
		if (gate) {
			const held = gate;
			gate = undefined;
			entered = true;
			await held;
		}
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
	return {
		factory,
		started,
		/** Hold the next start; returns the release. */
		hold(): () => void {
			const { promise, resolve } = Promise.withResolvers<void>();
			gate = promise;
			entered = false;
			return () => resolve();
		},
		entered: () => entered,
	};
}

async function until(
	condition: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function rpc(
	handle: DaemonHandle,
	method: string,
	params: unknown = {},
): Promise<{ result?: unknown; error?: { message: string } }> {
	const stateDir = join(handle.socketPath, "..");
	return (await controlCall(
		handle.socketPath,
		method,
		params,
		await operatorToken(stateDir),
	)) as { result?: unknown; error?: { message: string } };
}

async function answers(url: string): Promise<boolean> {
	try {
		await fetch(url);
		return true;
	} catch {
		return false;
	}
}

describe("bootDaemon — failed boot unwind", () => {
	test("an invalid OMA_CONSOLE_PORT refuses the boot and releases everything it started", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await writePeer(agentDir, "reviewer");
		const stateDir = join(agentDir, "oh-my-agent");
		const stub = stubFactory();
		let brokerUrl: string | undefined;

		await expect(
			bootDaemon({
				env: { OMA_CONSOLE_PORT: "80a" },
				agentDir,
				projectDir,
				workerFactory: stub.factory,
				fetchUpstream: (input, init) => {
					brokerUrl ??= new URL(input).origin;
					return fetch(input, init);
				},
			}),
		).rejects.toThrow('Invalid OMA_CONSOLE_PORT: "80a"');

		// The refusal comes late: the peer had started, and the broker and
		// credential gateway were listening. All of it has to be gone.
		const reviewer = stub.started.find((w) => w.name === "reviewer");
		expect(reviewer?.state()).toBe("stopped");
		expect(brokerUrl).toBeDefined();
		expect(await answers(`${brokerUrl}/v1/healthz`)).toBe(false);
		expect(await answers(reviewer?.gatewayUrl as string)).toBe(false);
		expect(existsSync(join(stateDir, "daemon.pid"))).toBe(false);
		expect(existsSync(join(stateDir, "daemon.sock"))).toBe(false);

		// Nothing held the pidfile or the database: a corrected boot comes up.
		const handle = await bootDaemon({
			env: { OMA_CONSOLE: "0" },
			agentDir,
			projectDir,
			workerFactory: stubFactory().factory,
		});
		cleanups.push(() => handle.close());
		const status = await rpc(handle, "status");
		expect(status.error).toBeUndefined();
	});

	test("an out-of-range OMA_CONSOLE_PORT refuses the boot", async () => {
		const agentDir = await tempDir();
		await expect(
			bootDaemon({
				env: { OMA_CONSOLE_PORT: "70000" },
				agentDir,
				projectDir: await tempDir(),
				workerFactory: stubFactory().factory,
			}),
		).rejects.toThrow("OMA_CONSOLE_PORT out of range: 70000");
		expect(existsSync(join(agentDir, "oh-my-agent", "daemon.pid"))).toBe(false);
	});
});

describe("bootDaemon — a spawn in flight", () => {
	test("a second start with a different parent is refused while the first is still starting", async () => {
		const agentDir = await tempDir();
		await writePeer(agentDir, "reviewer");
		const stub = stubFactory();
		const handle = await bootDaemon({
			env: { OMA_CONSOLE: "0" },
			agentDir,
			projectDir: await tempDir(),
			workerFactory: stub.factory,
		});
		cleanups.push(() => handle.close());

		expect((await rpc(handle, "kill", { name: "reviewer" })).error).toBe(
			undefined,
		);
		const release = stub.hold();
		const first = rpc(handle, "agent_spawn", { name: "reviewer" });
		try {
			await until(stub.entered, "first start reaches the factory");
			const second = await rpc(handle, "agent_spawn", {
				name: "reviewer",
				parent: "boss",
			});
			expect(second.error?.message ?? "").toContain(
				"already starting with a different parent",
			);
		} finally {
			release();
		}
		expect((await first).error).toBeUndefined();
	});

	test("shutdown waits for a start in flight and stops the worker it produced", async () => {
		const agentDir = await tempDir();
		await writePeer(agentDir, "reviewer");
		const logs: string[] = [];
		const stub = stubFactory();
		const handle = await bootDaemon({
			env: { OMA_CONSOLE: "0" },
			agentDir,
			projectDir: await tempDir(),
			workerFactory: stub.factory,
			logger: (line) => logs.push(line),
		});
		// Memoized, so the cleanup joins the close the test awaits below.
		cleanups.push(() => handle.close());

		await rpc(handle, "kill", { name: "reviewer" });
		const release = stub.hold();
		const spawn = rpc(handle, "agent_spawn", { name: "reviewer" }).catch(
			() => undefined,
		);
		let closed: Promise<void> | undefined;
		try {
			await until(stub.entered, "start reaches the factory");
			closed = handle.close();
			// Released once the socket is down, so the start finishes while the
			// shutdown is already under way.
			await until(
				async () =>
					!(await rpc(handle, "status").then(
						() => true,
						() => false,
					)),
				"control socket closes",
			);
		} finally {
			release();
		}
		await closed;
		await spawn;

		const late = stub.started.at(-1);
		expect(late?.name).toBe("reviewer");
		expect(late?.state()).toBe("stopped");
		expect(logs.filter((line) => /shutdown step .* failed/.test(line))).toEqual(
			[],
		);
	});
});

describe("bootDaemon — web routes as the builder wires them", () => {
	test("capabilities, chats, and attachments answer on the console listener", async () => {
		const agentDir = await tempDir();
		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir: await tempDir(),
			workerFactory: stubFactory().factory,
		});
		cleanups.push(() => handle.close());
		const url = new URL(handle.consoleUrl as string);
		const token = url.searchParams.get("token") as string;
		const api = (path: string, init: RequestInit = {}) =>
			fetch(`${url.origin}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					...(init.headers as Record<string, string> | undefined),
				},
			});

		// Without the web services the console answers `fullControl: false`
		// and every workspace route 404s.
		expect(await (await api("/api/capabilities")).json()).toEqual({
			fullControl: true,
		});
		const chats = await api("/api/chats");
		expect(chats.status).toBe(200);
		expect(await chats.json()).toEqual({ chats: [] });

		const uploaded = await api("/api/attachments", {
			method: "POST",
			body: "hello",
			headers: {
				"content-type": "text/plain",
				"x-attachment-name": "note.txt",
			},
		});
		expect(uploaded.status).toBe(201);
		const attachment = (await uploaded.json()) as { id: string };
		const listed = (await (await api("/api/attachments")).json()) as {
			attachments: { id: string }[];
		};
		expect(listed.attachments.map((entry) => entry.id)).toContain(
			attachment.id,
		);
		const removed = await api(
			`/api/attachments/${encodeURIComponent(attachment.id)}`,
			{ method: "DELETE" },
		);
		expect(removed.status).toBe(204);
	});
});

describe("bootDaemon — schedules_arm", () => {
	test("re-enabling a disarmed heartbeat arms it again", async () => {
		const agentDir = await tempDir();
		await writePeer(agentDir, "reviewer", {
			heartbeat: { every: "10m", prompt: "pulse" },
		});
		const handle = await bootDaemon({
			env: { OMA_CONSOLE: "0" },
			agentDir,
			projectDir: await tempDir(),
			workerFactory: stubFactory().factory,
		});
		cleanups.push(() => handle.close());
		const heartbeat = async () =>
			(
				(await rpc(handle, "schedules_list")).result as {
					schedules: { id: string; enabled: boolean; nextFireAt: number }[];
				}
			).schedules.find((s) => s.id === "reviewer:heartbeat");

		await rpc(handle, "schedules_arm", {
			scheduleId: "reviewer:heartbeat",
			enabled: false,
		});
		expect(await heartbeat()).toMatchObject({
			enabled: false,
			nextFireAt: null,
		});

		const before = Date.now();
		await rpc(handle, "schedules_arm", {
			scheduleId: "reviewer:heartbeat",
			enabled: true,
		});
		const armed = await heartbeat();
		expect(armed?.enabled).toBe(true);
		expect(armed?.nextFireAt).toBeGreaterThan(before);
	});
});
