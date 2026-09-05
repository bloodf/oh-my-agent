import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebAttachments } from "../src/daemon/web-attachments";
import { handleWebRoute, type WebServices } from "../src/daemon/web-routes";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(ttlMs = 1_000): Promise<{
	directory: string;
	attachments: WebAttachments;
}> {
	const directory = await mkdtemp(join(tmpdir(), "oma-attachments-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return { directory, attachments: new WebAttachments(directory, ttlMs) };
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function services(attachments: WebAttachments): WebServices {
	return {
		attachments,
		remoteFullControl: true,
		chats: {} as WebServices["chats"],
		plans: {} as WebServices["plans"],
	};
}

describe("temporary web attachments", () => {
	test("streams chunks to private owned storage without trusting filename paths", async () => {
		const { directory, attachments } = await fixture();
		const saved = await attachments.upload(stream("large", "-", "body"), {
			name: "../../secret\u0000.txt",
			type: "text/plain",
		});

		expect(saved.name).toBe(".._.._secret_.txt");
		expect(saved.path).toBe(join(directory, `${saved.id}.bin`));
		expect(await readFile(saved.path, "utf8")).toBe("large-body");
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
		expect(await attachments.list()).toEqual([saved]);
	});

	test("aborted upload removes partial data and metadata", async () => {
		const { directory, attachments } = await fixture();
		const abort = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1024));
			},
			cancel() {},
		});
		const upload = attachments.upload(
			body,
			{ name: "cancel.bin", type: "application/octet-stream" },
			abort.signal,
		);
		abort.abort(new Error("client disconnected"));

		await expect(upload).rejects.toThrow("client disconnected");
		expect(await readdir(directory)).toEqual([]);
	});

	test("source failure removes only incomplete owned files", async () => {
		const { directory, attachments } = await fixture();
		await writeFile(join(directory, "unrelated.txt"), "keep");
		const failed = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1024));
				controller.error(new Error("source failed"));
			},
		});
		await expect(
			attachments.upload(failed, {
				name: "failed.bin",
				type: "application/octet-stream",
			}),
		).rejects.toThrow("source failed");
		expect(await readdir(directory)).toEqual(["unrelated.txt"]);
	});

	test("delete and expiry remove owned records but never unrelated files", async () => {
		const { directory, attachments } = await fixture(10);
		const original = join(directory, "original.txt");
		await writeFile(original, "keep");
		const removed = await attachments.upload(stream("one"), {
			name: "one.txt",
			type: "text/plain",
		});
		await attachments.delete(removed.id);
		expect(await Bun.file(original).text()).toBe("keep");
		await expect(attachments.delete("../original.txt")).rejects.toThrow();

		const expired = await attachments.upload(stream("two"), {
			name: "two.txt",
			type: "text/plain",
		});
		await attachments.cleanup(Date.now() + 11);
		expect(await Bun.file(expired.path).exists()).toBe(false);
		expect(await Bun.file(original).text()).toBe("keep");
	});

	test("legacy fractional mtimes survive migration and remain operable", async () => {
		const { directory, attachments } = await fixture(60_000);
		const id = "123e4567-e89b-42d3-a456-426614174000";
		const name = "legacy.bin";
		const metadata = join(directory, `${id}.json`);
		const legacyData = join(directory, `${id}-${name}`);
		await writeFile(legacyData, "legacy");
		await writeFile(
			metadata,
			JSON.stringify({
				id,
				name,
				type: "application/octet-stream",
				size: 6,
				path: "/caller-controlled/path",
			}),
		);
		const fractional = (Date.now() - 1_000) / 1_000 + 0.123456;
		await utimes(metadata, fractional, fractional);

		const migrated = await attachments.get(id);
		expect(migrated.path).toBe(join(directory, `${id}.bin`));
		expect(await attachments.get(id)).toEqual(migrated);
		expect(await attachments.list()).toEqual([migrated]);
		await attachments.delete(id);
		expect(await readdir(directory)).toEqual([]);

		const expiredId = "123e4567-e89b-42d3-a456-426614174001";
		const expiredMetadata = join(directory, `${expiredId}.json`);
		await writeFile(join(directory, `${expiredId}-${name}`), "legacy");
		await writeFile(
			expiredMetadata,
			JSON.stringify({
				id: expiredId,
				name,
				type: "application/octet-stream",
				size: 6,
			}),
		);
		await utimes(expiredMetadata, fractional, fractional);
		await attachments.cleanup(Date.now() + 60_001);
		expect(await readdir(directory)).toEqual([]);
	});

	test("raw route accepts no content-length, lists and deletes by opaque id", async () => {
		const { attachments } = await fixture();
		const request = new Request("http://localhost/api/attachments", {
			method: "POST",
			headers: {
				"X-Attachment-Name": encodeURIComponent("report.bin"),
				"Content-Type": "application/octet-stream",
			},
			body: stream("a", "b"),
			duplex: "half",
		});
		const created = await handleWebRoute(
			request,
			new URL(request.url),
			services(attachments),
			false,
			() => {},
		);
		expect(created?.status).toBe(201);
		const saved = (await created?.json()) as { id: string; size: number };
		expect(saved.size).toBe(2);

		const listed = await handleWebRoute(
			new Request("http://localhost/api/attachments"),
			new URL("http://localhost/api/attachments"),
			services(attachments),
			false,
			() => {},
		);
		const listBody = (await listed?.json()) as { attachments: unknown[] };
		expect(listBody.attachments).toHaveLength(1);
		const deleted = await handleWebRoute(
			new Request(`http://localhost/api/attachments/${saved.id}`, {
				method: "DELETE",
			}),
			new URL(`http://localhost/api/attachments/${saved.id}`),
			services(attachments),
			false,
			() => {},
		);
		expect(deleted?.status).toBe(204);
	});

	test("remote attachment routes require full-control opt-in before body access", async () => {
		const { attachments, directory } = await fixture();
		const restricted = services(attachments);
		restricted.remoteFullControl = false;
		const response = await handleWebRoute(
			new Request("http://localhost/api/attachments", {
				method: "POST",
				body: stream("must not be consumed"),
				duplex: "half",
			}),
			new URL("http://localhost/api/attachments"),
			restricted,
			true,
			() => {},
		);
		expect(response?.status).toBe(403);
		expect(await readdir(directory)).toEqual([]);
	});
});
