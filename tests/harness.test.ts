import { describe, expect, test } from "bun:test";
import { access, stat } from "node:fs/promises";
import type {
	SnapshotResponse,
	SnapshotStreamSnapshotEvent,
} from "@oh-my-pi/pi-ai/auth-broker";
import { FakeBroker } from "./fixtures/fake-broker";
import { withTempAgentDir } from "./fixtures/temp-agent-dir";

describe("withTempAgentDir", () => {
	test("creates isolated dir with agents/ subdirectory", async () => {
		let dir = "";
		await withTempAgentDir(async (path) => {
			dir = path;
			const st = await stat(`${path}/agents`);
			expect(st.isDirectory()).toBe(true);
		});
		await expect(access(dir)).rejects.toThrow();
	});

	test("removes root after callback throws", async () => {
		let dir = "";
		await expect(
			withTempAgentDir(async (path) => {
				dir = path;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(access(dir)).rejects.toThrow();
	});
});

describe("FakeBroker", () => {
	test("start/close lifecycle", async () => {
		const broker = new FakeBroker();
		await broker.start();
		expect(broker.url).toBeString();
		await broker.close();
	});

	test("GET /v1/snapshot returns 401 without bearer token", async () => {
		const broker = new FakeBroker();
		await broker.start();
		try {
			const res = await fetch(`${broker.url}/v1/snapshot`);
			expect(res.status).toBe(401);
		} finally {
			await broker.close();
		}
	});

	test("GET /v1/snapshot returns 401 with wrong bearer", async () => {
		const broker = new FakeBroker();
		await broker.start();
		try {
			const res = await fetch(`${broker.url}/v1/snapshot`, {
				headers: { Authorization: "Bearer wrong-token" },
			});
			expect(res.status).toBe(401);
		} finally {
			await broker.close();
		}
	});

	test("GET /v1/snapshot returns 200 + ETag with valid bearer", async () => {
		const broker = new FakeBroker();
		await broker.start();
		try {
			const res = await fetch(`${broker.url}/v1/snapshot`, {
				headers: { Authorization: `Bearer ${broker.token}` },
			});
			expect(res.status).toBe(200);
			const etag = res.headers.get("etag");
			expect(etag).toMatch(/^"\d+"$/);
			const body = (await res.json()) as SnapshotResponse;
			expect(etag).toBe(`"${body.generation}"`);
			expect(body.generation).toBeGreaterThan(0);
		} finally {
			await broker.close();
		}
	});

	test("GET /v1/snapshot/stream first SSE event is full snapshot", async () => {
		const broker = new FakeBroker();
		await broker.start();
		try {
			const res = await fetch(`${broker.url}/v1/snapshot/stream`, {
				headers: { Authorization: `Bearer ${broker.token}` },
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");

			if (!res.body) throw new Error("snapshot stream had no body");
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let done = false;
			let frame = "";

			while (!done) {
				const { value, done: d } = await reader.read();
				done = d;
				if (value) {
					const chunk = decoder.decode(value, { stream: !done });
					frame += chunk;
					if (frame.includes("\n\n")) {
						break;
					}
				}
			}

			expect(frame).toContain("event: snapshot\n");
			const dataMatch = frame.match(/data: (.+)/);
			if (!dataMatch) throw new Error("snapshot stream had no data frame");
			const parsed = JSON.parse(dataMatch[1]) as SnapshotStreamSnapshotEvent;
			expect(parsed.kind).toBe("snapshot");
			expect(parsed.generation).toBeGreaterThan(0);
		} finally {
			await broker.close();
		}
	});

	test("close stops the server — fetch rejects", async () => {
		const broker = new FakeBroker();
		await broker.start();
		const url = broker.url;
		await broker.close();
		await expect(fetch(url)).rejects.toThrow();
	});
});
