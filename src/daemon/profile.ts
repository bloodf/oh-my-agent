/**
 * Purpose: The console's display profile — what the operator is called and
 * drawn as, and a display name and avatar per agent — kept beside the
 * daemon's other state so every browser sees the same names.
 *
 * Public API: `ProfileStore`, `openProfileStore(path)`, `Profile`,
 * `mergeProfile(current, patch)`.
 *
 * Upstream deps: node fs. No protocol involvement: authors on the wire stay
 * the identities the daemon enforces (`@you`, peer names); the profile only
 * changes how the console draws them.
 *
 * Downstream consumers: `./console-api` (`/api/profile`), `./runtime`
 * (opens it under the state dir).
 *
 * Failure modes: a missing or unreadable file is an empty profile. A patch
 * is validated field by field — short strings, or an avatar image as a small
 * base64 data URL — and refused whole on the first bad field, so a browser
 * never writes half a profile.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Persona {
	/** What the console shows in place of the wire author. */
	displayName?: string;
	/**
	 * One to four characters (an emoji or initials), or a
	 * `data:image/(png|jpeg|webp|gif);base64,…` URL of at most 200 KB decoded.
	 */
	avatar?: string;
}

export interface Profile {
	operator: Persona;
	agents: Record<string, Persona>;
}

export const EMPTY_PROFILE: Profile = { operator: {}, agents: {} };

const MAX_NAME = 40;
const MAX_AVATAR = 4;
/** Decoded bytes an avatar image may hold. */
export const MAX_AVATAR_IMAGE_BYTES = 200_000;
const IMAGE_AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,/;

/**
 * Check an avatar image data URL: an allowed mime, canonical base64, and a
 * decoded size under the cap. The length is checked before decoding so an
 * oversized value is refused without allocating its bytes.
 */
function imageAvatar(text: string, at: string): string {
	const header = IMAGE_AVATAR.exec(text);
	if (!header) {
		throw new Error(
			`${at} image must be a png, jpeg, webp, or gif base64 data URL`,
		);
	}
	const data = text.slice(header[0].length);
	if (
		data.length === 0 ||
		data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(data)
	) {
		throw new Error(`${at} image is not valid base64`);
	}
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	if ((data.length / 4) * 3 - padding > MAX_AVATAR_IMAGE_BYTES) {
		throw new Error(
			`${at} image must be at most ${MAX_AVATAR_IMAGE_BYTES / 1000} KB`,
		);
	}
	return text;
}

function persona(value: unknown, at: string): Persona {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${at} must be an object`);
	}
	const out: Persona = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "displayName" && key !== "avatar") {
			throw new Error(`${at}.${key} is not a profile field`);
		}
		if (entry === undefined || entry === null || entry === "") continue;
		if (typeof entry !== "string")
			throw new Error(`${at}.${key} must be a string`);
		const text = entry.trim();
		if (key === "avatar" && text.startsWith("data:")) {
			out.avatar = imageAvatar(text, `${at}.avatar`);
			continue;
		}
		const limit = key === "avatar" ? MAX_AVATAR : MAX_NAME;
		// Graphemes, not UTF-16 units: one emoji is one character of avatar.
		const length = [...new Intl.Segmenter().segment(text)].length;
		if (length === 0 || length > limit) {
			throw new Error(`${at}.${key} must be 1 to ${limit} characters`);
		}
		if (/[\n\r\t]/.test(text)) throw new Error(`${at}.${key} must be one line`);
		out[key] = text;
	}
	return out;
}

/** Validate a patch and lay it over the current profile; empty fields clear. */
export function mergeProfile(current: Profile, patch: unknown): Profile {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		throw new Error("profile must be an object");
	}
	const next: Profile = {
		operator: { ...current.operator },
		agents: { ...current.agents },
	};
	for (const [key, value] of Object.entries(patch)) {
		if (key === "operator") {
			next.operator = persona(value, "operator");
		} else if (key === "agents") {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error("agents must be an object");
			}
			for (const [name, entry] of Object.entries(value)) {
				if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
					throw new Error(`agents.${name} is not an agent name`);
				}
				const p = persona(entry, `agents.${name}`);
				if (Object.keys(p).length === 0) delete next.agents[name];
				else next.agents[name] = p;
			}
		} else {
			throw new Error(`${key} is not a profile field`);
		}
	}
	return next;
}

export interface ProfileStore {
	read(): Promise<Profile>;
	/** Apply a patch and persist; answers the profile as stored. */
	update(patch: unknown): Promise<Profile>;
}

export function openProfileStore(path: string): ProfileStore {
	let cached: Profile | undefined;
	const read = async (): Promise<Profile> => {
		if (cached) return cached;
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			cached = mergeProfile(EMPTY_PROFILE, parsed);
		} catch {
			cached = { operator: {}, agents: {} };
		}
		return cached;
	};
	// Updates run one at a time: each merges over the profile the previous
	// one stored, so two concurrent saves both land instead of the second
	// overwriting the first from a stale read. A refused patch rejects its own
	// caller without breaking the chain for the next.
	let tail: Promise<unknown> = Promise.resolve();
	let writes = 0;
	const write = async (patch: unknown): Promise<Profile> => {
		const next = mergeProfile(await read(), patch);
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${++writes}.tmp`;
		await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
		await rename(tmp, path);
		cached = next;
		return next;
	};
	return {
		read,
		update: (patch) => {
			const result = tail.then(() => write(patch));
			tail = result.catch(() => {});
			return result;
		},
	};
}
