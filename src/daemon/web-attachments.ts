import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface WebAttachment {
	id: string;
	name: string;
	type: string;
	size: number;
	path: string;
}
/** Operator uploads are opaque IDs, never caller-selected server paths. */
export class WebAttachments {
	constructor(private readonly directory: string) {}
	async upload(file: File): Promise<WebAttachment> {
		if (file.size > 32 * 1024 * 1024)
			throw new Error("Attachments must be 32 MiB or smaller");
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const id = randomUUID();
		const name =
			Array.from(file.name, (char) =>
				char.charCodeAt(0) < 32 ||
				char.charCodeAt(0) === 127 ||
				char === "/" ||
				char === "\\"
					? "_"
					: char,
			)
				.join("")
				.slice(0, 200) || "attachment";
		const attachment = {
			id,
			name,
			type: file.type || "application/octet-stream",
			size: file.size,
			path: join(this.directory, `${id}-${name}`),
		};
		await writeFile(attachment.path, new Uint8Array(await file.arrayBuffer()), {
			mode: 0o600,
			flag: "wx",
		});
		await writeFile(
			join(this.directory, `${id}.json`),
			JSON.stringify(attachment),
			{ mode: 0o600, flag: "wx" },
		);
		return attachment;
	}
	async get(id: string): Promise<WebAttachment> {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
				id,
			)
		)
			throw new Error("Invalid attachment ID");
		const value = JSON.parse(
			await readFile(join(this.directory, `${id}.json`), "utf8"),
		) as WebAttachment;
		return value;
	}
}
