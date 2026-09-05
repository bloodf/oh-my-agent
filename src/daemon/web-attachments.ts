import { randomUUID } from "node:crypto";
import {
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface WebAttachment {
	id: string;
	name: string;
	type: string;
	size: number;
	path: string;
}

interface StoredAttachment {
	id: string;
	name: string;
	type: string;
	size: number;
	createdAt: number;
	complete: boolean;
}

interface UploadReader {
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
}

interface ParsedMetadata {
	stored: StoredAttachment;
	legacy: boolean;
}

export const WEB_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeName(value: string): string {
	const safe = Array.from(value, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 || char === "/" || char === "\\"
			? "_"
			: char;
	})
		.join("")
		.slice(0, 200);
	return safe || "attachment";
}

function safeType(value: string): string {
	const type = value.trim();
	for (const char of type) {
		const code = char.charCodeAt(0);
		if (code < 32 || code === 127) return "application/octet-stream";
	}
	return type && type.length <= 200 ? type : "application/octet-stream";
}

function parseMetadata(
	id: string,
	value: string,
	metadataMtime: number,
): ParsedMetadata | undefined {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (
			parsed.id !== id ||
			!ID_PATTERN.test(id) ||
			typeof parsed.name !== "string" ||
			parsed.name !== safeName(parsed.name) ||
			typeof parsed.type !== "string" ||
			parsed.type !== safeType(parsed.type) ||
			!Number.isSafeInteger(parsed.size) ||
			(parsed.size as number) < 0
		)
			return;
		const modern =
			Number.isSafeInteger(parsed.createdAt) &&
			(parsed.createdAt as number) >= 0 &&
			typeof parsed.complete === "boolean";
		return {
			stored: {
				id,
				name: parsed.name,
				type: parsed.type,
				size: parsed.size as number,
				createdAt: modern
					? (parsed.createdAt as number)
					: Math.floor(metadataMtime),
				complete: modern ? (parsed.complete as boolean) : true,
			},
			legacy: !modern,
		};
	} catch {
		return;
	}
}

/**
 * Private temporary uploads. Completed files survive daemon restarts and remain
 * until explicit deletion or `WEB_ATTACHMENT_TTL_MS` expiry.
 */
export class WebAttachments {
	private readonly directory: string;
	private readonly active = new Set<string>();

	constructor(
		directory: string,
		private readonly ttlMs = WEB_ATTACHMENT_TTL_MS,
	) {
		this.directory = isAbsolute(directory) ? directory : resolve(directory);
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const info = await lstat(this.directory);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("Attachment directory must be a private directory");
		await chmod(this.directory, 0o700);
	}

	private paths(id: string) {
		return {
			partial: join(this.directory, `${id}.part`),
			data: join(this.directory, `${id}.bin`),
			metadata: join(this.directory, `${id}.json`),
		};
	}

	private async readOwned(id: string): Promise<StoredAttachment> {
		if (!ID_PATTERN.test(id)) throw new Error("Invalid attachment ID");
		const paths = this.paths(id);
		const metadataInfo = await lstat(paths.metadata);
		if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink())
			throw new Error("Attachment not found");
		const parsed = parseMetadata(
			id,
			await readFile(paths.metadata, "utf8"),
			metadataInfo.mtimeMs,
		);
		if (!parsed?.stored.complete) throw new Error("Attachment not found");
		if (parsed.legacy) {
			const legacyPath = join(this.directory, `${id}-${parsed.stored.name}`);
			const legacyInfo = await lstat(legacyPath);
			if (
				!legacyInfo.isFile() ||
				legacyInfo.isSymbolicLink() ||
				legacyInfo.size !== parsed.stored.size
			)
				throw new Error("Attachment not found");
			await rename(legacyPath, paths.data);
			await writeFile(paths.metadata, JSON.stringify(parsed.stored), {
				mode: 0o600,
			});
		}
		const dataInfo = await lstat(paths.data);
		if (
			!dataInfo.isFile() ||
			dataInfo.isSymbolicLink() ||
			dataInfo.size !== parsed.stored.size
		)
			throw new Error("Attachment not found");
		return parsed.stored;
	}

	async upload(
		stream: ReadableStream<Uint8Array>,
		metadata: { name: string; type: string },
		signal?: AbortSignal,
	): Promise<WebAttachment> {
		await this.ensureDirectory();
		const id = randomUUID();
		const paths = this.paths(id);
		const stored: StoredAttachment = {
			id,
			name: safeName(metadata.name),
			type: safeType(metadata.type),
			size: 0,
			createdAt: Date.now(),
			complete: false,
		};
		this.active.add(id);
		let file: FileHandle | undefined;
		let reader: UploadReader | undefined;
		let complete = false;
		const onAbort = () => {
			void reader?.cancel(signal?.reason).catch(() => {});
		};
		try {
			await writeFile(paths.metadata, JSON.stringify(stored), {
				mode: 0o600,
				flag: "wx",
			});
			file = await open(paths.partial, "wx", 0o600);
			const uploadReader = stream.getReader();
			reader = uploadReader;
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			while (true) {
				const next = await uploadReader.read();
				if (next.done) break;
				let offset = 0;
				while (offset < next.value.byteLength) {
					const { bytesWritten } = await file.write(
						next.value,
						offset,
						next.value.byteLength - offset,
					);
					if (bytesWritten === 0)
						throw new Error("Attachment write made no progress");
					offset += bytesWritten;
					stored.size += bytesWritten;
				}
			}
			if (signal?.aborted) throw signal.reason ?? new Error("Upload aborted");
			await file.close();
			file = undefined;
			await rename(paths.partial, paths.data);
			stored.complete = true;
			await writeFile(paths.metadata, JSON.stringify(stored), {
				mode: 0o600,
			});
			complete = true;
			return {
				id: stored.id,
				name: stored.name,
				type: stored.type,
				size: stored.size,
				path: paths.data,
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (!complete) await reader?.cancel(signal?.reason).catch(() => {});
			reader?.releaseLock();
			await file?.close().catch(() => {});
			if (!complete) {
				await rm(paths.partial, { force: true }).catch(() => {});
				await rm(paths.data, { force: true }).catch(() => {});
				await rm(paths.metadata, { force: true }).catch(() => {});
			}
			this.active.delete(id);
		}
	}

	async get(id: string): Promise<WebAttachment> {
		const stored = await this.readOwned(id);
		if (Date.now() - stored.createdAt >= this.ttlMs) {
			await this.delete(id);
			throw new Error("Attachment expired");
		}
		return {
			id: stored.id,
			name: stored.name,
			type: stored.type,
			size: stored.size,
			path: this.paths(id).data,
		};
	}

	async list(): Promise<WebAttachment[]> {
		await this.cleanup();
		const attachments: WebAttachment[] = [];
		for (const entry of await readdir(this.directory, {
			withFileTypes: true,
		})) {
			const match = /^([0-9a-f-]+)\.json$/.exec(entry.name);
			if (!entry.isFile() || !match || !ID_PATTERN.test(match[1])) continue;
			try {
				attachments.push(await this.get(match[1]));
			} catch {
				// Ignore incomplete, expired, or corrupted owned records.
			}
		}
		return attachments.sort((a, b) => a.id.localeCompare(b.id));
	}

	async delete(id: string): Promise<void> {
		await this.readOwned(id);
		const paths = this.paths(id);
		await rm(paths.data);
		await rm(paths.metadata, { force: true });
	}

	async cleanup(now = Date.now()): Promise<void> {
		await this.ensureDirectory();
		for (const entry of await readdir(this.directory, {
			withFileTypes: true,
		})) {
			const match = /^([0-9a-f-]+)\.json$/.exec(entry.name);
			if (!entry.isFile() || !match || !ID_PATTERN.test(match[1])) continue;
			const id = match[1];
			if (this.active.has(id)) continue;
			const paths = this.paths(id);
			let parsed: ParsedMetadata | undefined;
			try {
				const metadataInfo = await lstat(paths.metadata);
				parsed = parseMetadata(
					id,
					await readFile(paths.metadata, "utf8"),
					metadataInfo.mtimeMs,
				);
			} catch {
				// Concurrent deletion or disappearance must not stop the sweep.
				continue;
			}
			if (!parsed) continue;
			let stored = parsed.stored;
			if (stored.complete) {
				try {
					stored = await this.readOwned(id);
				} catch {
					continue;
				}
			}
			if (stored.complete && now - stored.createdAt < this.ttlMs) continue;
			await rm(paths.metadata, { force: true });
			await rm(paths.partial, { force: true });
			await rm(paths.data, { force: true });
		}
	}
}
