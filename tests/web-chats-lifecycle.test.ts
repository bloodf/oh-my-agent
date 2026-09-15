import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

import {
	chatAlive,
	createWebChats,
	stopChatProcess,
	writeChatShim,
} from "../src/daemon/web-chats";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean> | boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in 10s");
		await Bun.sleep(20);
	}
}

/** Where `createWebChats` puts an instance's storage when nobody interferes. */
function preferredStorageDir(stateDir: string): string {
	const hash = createHash("sha256")
		.update(resolve(stateDir))
		.digest("hex")
		.slice(0, 16);
	const owner =
		typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `oh-my-agent-web-${owner}-${hash}`);
}

describe("web chat storage directory", () => {
	for (const squatter of ["symlink", "file"] as const) {
		test(`a pre-created ${squatter} at the storage path neither blocks boot nor is used`, async () => {
			const dir = await tempDir("oma-chat-storage-");
			const stateDir = join(dir, "state");
			const preferred = preferredStorageDir(stateDir);
			const elsewhere = join(dir, "elsewhere");
			await mkdir(elsewhere);
			if (squatter === "symlink") await symlink(elsewhere, preferred);
			else await writeFile(preferred, "");
			cleanups.push(() => rm(preferred, { force: true }));

			const chats = await createWebChats({ stateDir });
			cleanups.push(async () => {
				await chats.close();
				await rm(chats.storageDir, { recursive: true, force: true });
			});

			expect(chats.storageDir).not.toBe(preferred);
			const info = await lstat(chats.storageDir);
			expect(info.isDirectory()).toBe(true);
			expect(info.mode & 0o777).toBe(0o700);
			expect(await readdir(elsewhere)).toEqual([]);
		});
	}
});

describe("closing a web chat", () => {
	test("removes its session transcript and launch files", async () => {
		const dir = await tempDir("oma-chat-close-");
		const stateDir = join(dir, "state");
		const first = await createWebChats({ stateDir });
		const storageDir = first.storageDir;
		await first.close();
		cleanups.push(() => rm(storageDir, { recursive: true, force: true }));

		// Seeded on disk rather than launched: opening a chat needs OMP and a
		// configured model, and closing one never starts it.
		const id = "chat-close-1";
		const sessionFile = join(storageDir, "sessions", "chat-close-1.jsonl");
		const shim = join(storageDir, "shims", `${id}.ts`);
		const pid = join(storageDir, "shims", `${id}.pid`);
		await writeFile(sessionFile, '{"type":"session"}\n');
		await writeFile(shim, "");
		await writeFile(pid, "1\n");
		await writeFile(
			join(storageDir, "web-chats.json"),
			JSON.stringify([
				{ id, title: "t", cwd: dir, createdAt: 1, updatedAt: 1, sessionFile },
			]),
		);

		const chats = await createWebChats({ stateDir });
		cleanups.push(() => chats.close());
		await chats.closeChat(id);

		expect(await chats.list()).toEqual([]);
		for (const path of [sessionFile, shim, pid]) {
			expect(await Bun.file(path).exists()).toBe(false);
		}
	});
});

describe("web chat process group", () => {
	test("liveness follows the OMP process, not only the shim", async () => {
		const dir = await tempDir("oma-chat-alive-");
		const pidPath = join(dir, "chat.pid");
		const gone = Bun.spawn(["true"]);
		await gone.exited;

		await writeFile(pidPath, `${process.pid}\n${process.pid}`);
		expect(chatAlive({}, pidPath)).toBe(true);
		await writeFile(pidPath, `${process.pid}\n${gone.pid}`);
		expect(chatAlive({}, pidPath)).toBe(false);
	});

	test("stopping a chat whose shim was SIGKILLed still kills OMP and its children", async () => {
		// A stand-in for OMP: speaks just enough RPC to become ready and holds a
		// child of its own the way a running tool would. The client's own stop
		// walks the shim's process tree, which no longer reaches OMP once the
		// shim is gone and OMP has been reparented.
		const dir = await tempDir("oma-chat-group-");
		const pidsFile = join(dir, "omp.pids");
		const cli = join(dir, "fake-omp.ts");
		await writeFile(
			cli,
			[
				'const tool = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });',
				`await Bun.write(${JSON.stringify(pidsFile)}, \`\${process.pid}\\n\${tool.pid}\`);`,
				'console.log(JSON.stringify({ type: "ready" }));',
				"setInterval(() => {}, 1_000);",
				"",
			].join("\n"),
		);
		const { shimPath, pidPath } = await writeChatShim(dir, "chat-1", cli);
		const client = new RpcClient({
			cliPath: shimPath,
			terminationGraceMs: 200,
		});
		let pids: number[] = [];
		cleanups.push(async () => {
			// Processes first: a leaked OMP holds the client's pipes open and
			// would keep its stop from ever settling.
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await client.stop().catch(() => {});
		});

		await client.start();
		await waitFor(() => Bun.file(pidsFile).exists());
		pids = (await readFile(pidsFile, "utf8")).split("\n").map(Number);
		expect(pids.every(alive)).toBe(true);
		expect(chatAlive({}, pidPath)).toBe(true);

		// What the OOM killer or an operator's kill -9 does to the shim.
		const shimPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
		process.kill(shimPid, "SIGKILL");
		await waitFor(() => !alive(shimPid));
		expect(pids.every(alive)).toBe(true);
		expect(chatAlive({}, pidPath)).toBe(false);

		await stopChatProcess(client, pidPath);

		await waitFor(() => pids.every((pid) => !alive(pid)));
	});
});
