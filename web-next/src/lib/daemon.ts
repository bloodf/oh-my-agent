/**
 * Purpose: The server's side of the daemon: where it is and the operator
 * token that opens it, resolved once per process and never sent to a
 * browser. Every page and route handler fetches through here.
 *
 * Upstream deps: node fs for `console-url`, which the daemon writes under
 * its state dir on boot. `OMA_CONSOLE_URL` overrides it for a daemon that
 * runs elsewhere.
 *
 * Downstream consumers: pages (server components), `app/api` route
 * handlers (the proxy), `app/api/live` (the event stream).
 *
 * Failure modes: no daemon URL is one error with the two ways to provide
 * one; a daemon refusal comes back with its own status and message.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Daemon {
	/** `http://127.0.0.1:<port>` */
	origin: string;
	token: string;
}

let cached: Promise<Daemon> | undefined;

async function resolve(): Promise<Daemon> {
	const raw =
		process.env.OMA_CONSOLE_URL?.trim() ||
		(
			await readFile(
				join(
					process.env.PI_CODING_AGENT_DIR?.trim() ||
						join(homedir(), ".omp", "agent"),
					"oh-my-agent",
					"console-url",
				),
				"utf8",
			).catch(() => "")
		).trim();
	if (raw.length === 0) {
		throw new Error(
			"No oh-my-agent console to serve: start the daemon (its console-url file is read from PI_CODING_AGENT_DIR) or set OMA_CONSOLE_URL to its loopback URL with the token.",
		);
	}
	const url = new URL(raw);
	const token = url.searchParams.get("token") ?? "";
	if (token.length === 0)
		throw new Error("The console URL carries no operator token.");
	return { origin: url.origin, token };
}

export function daemon(): Promise<Daemon> {
	cached ??= resolve().catch((error) => {
		cached = undefined;
		throw error;
	});
	return cached;
}

/** One authenticated call to the daemon's console API, JSON in and out. */
export async function daemonFetch<T = Record<string, unknown>>(
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; payload: T }> {
	const { origin, token } = await daemon();
	const response = await fetch(`${origin}${path}`, {
		method: init.method ?? "GET",
		headers: {
			"X-Operator-Token": token,
			...(init.body === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		cache: "no-store",
	});
	const text = await response.text();
	let payload: T;
	try {
		payload = JSON.parse(text) as T;
	} catch {
		payload = { error: { message: text || `HTTP ${response.status}` } } as T;
	}
	return { status: response.status, payload };
}

/** A read that a page can rely on; a refusal becomes a thrown error. */
export async function daemonGet<T>(path: string): Promise<T> {
	const { status, payload } = await daemonFetch<
		T & { error?: { message?: string } }
	>(path);
	if (status >= 400) {
		throw new Error(payload.error?.message ?? `${path} answered ${status}`);
	}
	return payload;
}
