/**
 * Browser seams the real console talks through: `fetch` for `/api/*`,
 * `WebSocket` for `/api/events`, and `XMLHttpRequest` for uploads. Anything
 * else passes straight through to the browser (Next's own HMR socket included).
 */
import { ensureLive } from "./activity";
import { subscribe } from "./bus";
import { DEMO_TOKEN } from "./demoToken";
import { handleApi, hasOperatorToken } from "./router";
import { MAX_UPLOAD_BYTES, recordUpload } from "./routes/workspace";

const LATENCY_MS = [35, 110] as const;
const delay = () => new Promise((resolve) => setTimeout(resolve, LATENCY_MS[0] + Math.random() * (LATENCY_MS[1] - LATENCY_MS[0])));

function apiUrl(input: string | URL): URL | undefined {
	const url = new URL(String(input), location.href);
	return url.origin === location.origin && url.pathname.startsWith("/api/") ? url : undefined;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	new Headers(headers).forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

function installFetch(): void {
	const realFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : undefined;
		const url = apiUrl(request ? request.url : input as string | URL);
		if (!url) return realFetch(input, init);
		const headers = { ...headerRecord(request?.headers), ...headerRecord(init?.headers) };
		const rawBody = init?.body ?? (request ? await request.clone().text() : undefined);
		let body: unknown;
		if (typeof rawBody === "string" && rawBody.length > 0) {
			try {
				body = JSON.parse(rawBody);
			} catch {
				body = undefined;
			}
		}
		await delay();
		const result = await handleApi({ method: init?.method ?? request?.method ?? "GET", url, headers, body });
		const empty = result.status === 204 || result.body === null;
		return new Response(empty ? null : JSON.stringify(result.body), {
			status: result.status,
			headers: empty ? {} : { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function installWebSocket(): void {
	const RealWebSocket = globalThis.WebSocket;

	class DemoEventsSocket extends EventTarget {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly CONNECTING = 0;
		readonly OPEN = 1;
		readonly CLOSING = 2;
		readonly CLOSED = 3;
		url = "";
		readonly protocol = "";
		readonly extensions = "";
		binaryType: BinaryType = "blob";
		bufferedAmount = 0;
		readyState = 0;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onclose: ((event: CloseEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		private unsubscribe: (() => void) | undefined;

		constructor(url: string | URL, protocols?: string | string[]) {
			super();
			const target = new URL(String(url), location.href);
			if (target.origin.replace(/^http/, "ws") !== location.origin.replace(/^http/, "ws") || target.pathname !== "/api/events") {
				// Not ours: hand back a real socket from the constructor.
				return new RealWebSocket(url, protocols) as unknown as DemoEventsSocket;
			}
			this.url = target.href;
			const authorized = target.searchParams.get("token") === DEMO_TOKEN || target.searchParams.has("ticket");
			setTimeout(() => {
				if (this.readyState !== 0) return;
				if (!authorized) {
					this.finish(1008, "Operator token required");
					return;
				}
				this.readyState = 1;
				this.unsubscribe = subscribe((frame) => this.deliver(JSON.stringify(frame)));
				this.fire("open", new Event("open"));
				ensureLive();
			}, 60);
		}

		private fire(type: "open" | "message" | "close" | "error", event: Event): void {
			const handler = this[`on${type}`] as ((event: Event) => void) | null;
			handler?.call(this, event);
			this.dispatchEvent(event);
		}

		private deliver(data: string): void {
			// Async like a real socket, so a frame never lands inside the write that caused it.
			setTimeout(() => {
				if (this.readyState === 1) this.fire("message", new MessageEvent("message", { data }));
			}, 0);
		}

		private finish(code: number, reason: string): void {
			if (this.readyState === 3) return;
			this.unsubscribe?.();
			this.readyState = 3;
			this.fire("close", new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
		}

		send(): void {
			// The daemon ignores client frames on /api/events.
		}

		close(code = 1000, reason = ""): void {
			this.readyState = 2;
			setTimeout(() => this.finish(code, reason), 0);
		}
	}

	globalThis.WebSocket = DemoEventsSocket as unknown as typeof WebSocket;
}

function installXhr(): void {
	const RealXHR = globalThis.XMLHttpRequest;

	class DemoXHR extends RealXHR {
		private demo: { method: string; url: URL; headers: Record<string, string>; status: number; response: string; timers: ReturnType<typeof setTimeout>[]; done: boolean } | undefined;

		override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null): void {
			const target = apiUrl(url);
			if (method.toUpperCase() === "POST" && target?.pathname === "/api/attachments") {
				this.demo = { method, url: target, headers: {}, status: 0, response: "", timers: [], done: false };
				return;
			}
			this.demo = undefined;
			super.open(method, url, async, username, password);
		}

		override setRequestHeader(name: string, value: string): void {
			if (this.demo) this.demo.headers[name.toLowerCase()] = value;
			else super.setRequestHeader(name, value);
		}

		override get status(): number {
			return this.demo ? this.demo.status : super.status;
		}

		override get responseText(): string {
			return this.demo ? this.demo.response : super.responseText;
		}

		override get readyState(): number {
			return this.demo ? (this.demo.done ? 4 : 1) : super.readyState;
		}

		private emit(target: EventTarget, type: string, event: Event): void {
			const handler = (target as unknown as Record<string, unknown>)[`on${type}`];
			if (typeof handler === "function") handler.call(target, event);
			target.dispatchEvent(event);
		}

		override send(body?: Document | XMLHttpRequestBodyInit | null): void {
			const demo = this.demo;
			if (!demo) {
				super.send(body);
				return;
			}
			const total = body instanceof Blob ? body.size : typeof body === "string" ? body.length : 0;
			const name = (() => {
				try {
					return decodeURIComponent(demo.headers["x-attachment-name"] ?? "");
				} catch {
					return "";
				}
			})();
			const steps = 10;
			const duration = Math.min(2_400, 700 + total / 2_000);
			for (let step = 1; step <= steps; step++) {
				demo.timers.push(
					setTimeout(() => {
						const loaded = Math.round((total * step) / steps);
						this.emit(this.upload, "progress", new ProgressEvent("progress", { loaded, total, lengthComputable: true }));
						if (step < steps) return;
						if (!hasOperatorToken(demo.headers)) {
							demo.status = 401;
							demo.response = JSON.stringify({ error: { code: "unauthorized", message: "Operator token refused" } });
						} else if (total > MAX_UPLOAD_BYTES) {
							demo.status = 413;
							demo.response = JSON.stringify({ error: { code: "payload_too_large", message: "Attachment exceeds 25 MiB" } });
						} else if (!name) {
							demo.status = 400;
							demo.response = JSON.stringify({ error: { code: "workspace_error", message: "Attachment name is required" } });
						} else {
							demo.status = 201;
							demo.response = JSON.stringify(recordUpload(name, demo.headers["content-type"] || "application/octet-stream", total));
						}
						demo.done = true;
						this.emit(this, "load", new ProgressEvent("load", { loaded: total, total }));
						this.emit(this, "loadend", new ProgressEvent("loadend", { loaded: total, total }));
					}, (duration * step) / steps),
				);
			}
		}

		override abort(): void {
			const demo = this.demo;
			if (!demo) {
				super.abort();
				return;
			}
			if (demo.done) return;
			for (const timer of demo.timers) clearTimeout(timer);
			demo.done = true;
			this.emit(this, "abort", new ProgressEvent("abort"));
			this.emit(this, "loadend", new ProgressEvent("loadend"));
		}
	}

	globalThis.XMLHttpRequest = DemoXHR;
}

let installed = false;
const originals = { fetch: undefined as typeof fetch | undefined, WebSocket: undefined as typeof WebSocket | undefined, XMLHttpRequest: undefined as typeof XMLHttpRequest | undefined };

function uninstallDemoTransport(): void {
	if (!installed) return;
	installed = false;
	if (originals.fetch) globalThis.fetch = originals.fetch;
	if (originals.WebSocket) globalThis.WebSocket = originals.WebSocket;
	if (originals.XMLHttpRequest) globalThis.XMLHttpRequest = originals.XMLHttpRequest;
}

/** Patch the browser seams once, before the console mounts; the result undoes it. */
export function installDemoTransport(): () => void {
	if (typeof window === "undefined") return () => {};
	if (!installed) {
		installed = true;
		originals.fetch = globalThis.fetch;
		originals.WebSocket = globalThis.WebSocket;
		originals.XMLHttpRequest = globalThis.XMLHttpRequest;
		installFetch();
		installWebSocket();
		installXhr();
	}
	return uninstallDemoTransport;
}
