/**
 * RED tests for src/console (T-603): the browser client.
 *
 * Unlike unit suites, these drive a real Chrome (chrome-headless-shell via
 * puppeteer-core) against a running console API plus a tiny static server for
 * the client files. Assertions read what the browser rendered and did — DOM
 * text, element counts — never source text, so the suite fails while
 * app.ts/index.html do not exist or do not behave.
 *
 * Server-side gaps the client cannot paper over are bridged by a proxy layer
 * in the test harness (reaction toggle): the browser posts there, the proxy
 * executes against the room store, and the client re-reads the canonical
 * state — exactly what the eventual server route returns. The proxy is
 * removed the day T-605 ships the route; the assertions do not change.
 *
 * Waits are event-driven (poll DOM/store conditions), never fixed sleeps:
 * real timers bind CI to wall-clock latency and mask races. The one genuine
 * real-time need — observing the browser's reconnect backoff — is handled by
 * waiting on the rendered outcome, which subsumes the backoff.
 *
 * @Environment bun
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { type ConsoleApi, startConsoleApi } from "../src/daemon/console-api";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import type { RoomMessage, RoomStore } from "../src/rooms/store";
import { RoomStore as Store } from "../src/rooms/store";
import type { RoomInfo } from "../src/shared/protocol";

// ── Browser ──────────────────────────────────────────────────────────────────

const CHROME = join(
	homedir(),
	".cache/puppeteer/chrome-headless-shell/mac_arm-152.0.7977.42/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

let browser: Browser;

beforeAll(async () => {
	browser = await puppeteer.launch({
		executablePath: CHROME,
		args: ["--no-sandbox"],
	});
	browser.on("disconnected", () => {
		console.error("[browser disconnected]");
	});
});

afterAll(async () => {
	await browser?.close();
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup === undefined) continue;
		await cleanup();
	}
});

/** A page plus the client-side errors it raised (pageerror + console.error). */
interface TrackedPage {
	page: Page;
	errors: string[];
}

async function openPage(): Promise<TrackedPage> {
	const page = await browser.newPage();
	// RED runs must fail fast; 5s default hides a missing client behind a hang.
	page.setDefaultTimeout(1_500);
	let closed = false;
	cleanups.push(async function cleanupPage() {
		if (closed) return;
		closed = true;
		await page.close().catch(() => {});
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return { page, errors };
}

// ── Event-driven waits ───────────────────────────────────────────────────────

/** Poll a condition until it holds; failure names the last observed value. */
async function waitFor<T>(
	label: string,
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	for (;;) {
		last = await read();
		if (predicate(last)) return last;
		if (Date.now() > deadline) {
			throw new Error(
				`Timed out waiting for ${label}; last: ${JSON.stringify(last)}`,
			);
		}
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 20);
		await tick.promise;
	}
}

/** Transcript bodies rendered in the channel pane. */
const renderedMessages = (page: Page): Promise<string[]> =>
	page.$$eval("#messages .message .body", (nodes) =>
		nodes.map((n) => (n.textContent ?? "").trim()),
	);

/** Reaction chips rendered for one message: raw text like "👀 2". */
const renderedReactions = (page: Page, messageId: number): Promise<string[]> =>
	page.$$eval(`#messages .message[data-id="${messageId}"] .reaction`, (nodes) =>
		nodes.map((n) => (n.textContent ?? "").trim()),
	);

const transcriptText = (page: Page): Promise<string> =>
	page.$eval("#messages", (node) => node.textContent ?? "").catch(() => "");

// ── Daemon harness (mirrors tests/console-api.test.ts) ──────────────────────

const TOKEN = "operator-token";

function stubWorker(name = "reviewer") {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";

	const worker: SupervisedWorker = {
		name,
		get state() {
			return state;
		},
		prompt: async (message) => {
			prompts.push(message);
		},
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

	return { worker, prompts };
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".ts": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

/**
 * The daemon's composition (store + supervisor + console API), plus a static
 * server for the client files and a proxy for the reaction-toggle write the
 * HTTP surface does not expose yet. Everything the browser talks to is here.
 */
async function harness(options: { pollIntervalMs?: number } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-console-client-"));
	cleanups.push(async function cleanupRm() {
		await rm(dir, { recursive: true, force: true });
	});

	const rooms: RoomStore = await Store.open(join(dir, "rooms.db"));
	cleanups.push(async function cleanupRooms() {
		await rooms.close();
	});

	const scheduler = new Scheduler({
		now: () => Date.now(),
		setTimer: () => 0,
		clearTimer: () => {},
	});
	scheduler.start();

	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => Date.now(),
	});

	const peers = new Map<string, PeerRecord>();
	const knownRooms = new Map<string, RoomInfo>();
	const ensureRoom = async (id: string): Promise<void> => {
		if (knownRooms.has(id)) return;
		const kind = id.startsWith("@") ? "dm" : "channel";
		await rooms.createRoom({ id, kind });
		knownRooms.set(id, { id, kind, name: id });
	};

	const api: ConsoleApi = await startConsoleApi({
		rooms,
		supervisor,
		peers,
		knownRooms,
		ensureRoom,
		token: TOKEN,
		pollIntervalMs: options.pollIntervalMs ?? 25,
	});

	const registerPeer = async (
		name: string,
		roomIds: string[],
	): Promise<{ prompts: string[] }> => {
		const stub = stubWorker(name);
		for (const room of roomIds) await ensureRoom(room);
		await supervisor.register({
			worker: stub.worker,
			accountId: "acct-1",
			mode: "subscription",
			rooms: roomIds,
		});
		peers.set(name, {
			worker: stub.worker,
			accountId: "acct-1",
			rooms: roomIds,
		});
		return stub;
	};

	/** Wait until the stub worker has been prompted with a body. */
	const promptsContaining = (
		prompts: string[],
		body: string,
	): Promise<string[]> =>
		waitFor(
			`worker prompt containing ${JSON.stringify(body)}`,
			() => Promise.resolve(prompts),
			(list) => list.some((line) => line.includes(body)),
		);

	/**
	 * Static client files + API proxy + the reaction-toggle route the console
	 * API lacks. The browser sends its token in a custom header, rewritten to
	 * Authorization here so no token lands in a URL anywhere.
	 */
	const staticRoot = join(import.meta.dir, "../src/console");
	/** Browser-side socket by its upstream connection, and frames that
	 * arrived before the pair was linked. */
	const downstreamByUpstream = new Map<
		WebSocket,
		Bun.ServerWebSocket<WebSocket>
	>();
	const pendingFrames = new Map<WebSocket, string[]>();
	const web = Bun.serve<WebSocket>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			// The live feed must reach the browser, so /api/events is proxied
			// as a real socket pair: a plain 400 handshake logs a console error
			// in the page and no event ever flows.
			if (url.pathname === "/api/events") {
				const upstreamUrl = new URL(api.url + url.pathname + url.search);
				upstreamUrl.protocol =
					upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
				const upstream = new WebSocket(upstreamUrl.href);
				pendingFrames.set(upstream, []);
				upstream.addEventListener("message", (event) => {
					const socket = downstreamByUpstream.get(upstream);
					if (socket === undefined) {
						pendingFrames.get(upstream)?.push(String(event.data));
						return;
					}
					socket.send(String(event.data));
				});
				upstream.addEventListener("close", () => {
					downstreamByUpstream.get(upstream)?.close();
				});
				const upgraded = web.upgrade(request, { data: upstream });
				if (!upgraded) {
					upstream.close();
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return undefined;
			}

			if (url.pathname.startsWith("/api/")) {
				const headers = new Headers(request.headers);
				const presented = request.headers.get("X-Operator-Token");
				if (presented !== null) {
					headers.set("Authorization", `Bearer ${presented}`);
					headers.delete("X-Operator-Token");
				}

				const toggle = /^\/api\/messages\/(\d+)\/reactions\/toggle$/.exec(
					url.pathname,
				);
				if (toggle?.[1] !== undefined && request.method === "POST") {
					const payload = (await request.json()) as {
						actor?: string;
						emoji?: string;
					};
					const messageId = Number(toggle[1]);
					const actor = payload.actor ?? "@you";
					const emoji = payload.emoji ?? "";
					const target = await findMessage(rooms, messageId);
					if (target === undefined) {
						return Response.json(
							{ error: { code: "not_found", message: "No such message" } },
							{ status: 404 },
						);
					}
					const mine = target.reactions.some(
						(r) => r.actor === actor && r.emoji === emoji,
					);
					if (mine) await rooms.unreact(messageId, actor, emoji);
					else await rooms.react(messageId, actor, emoji);
					return Response.json({ ok: true });
				}

				const upstream = new URL(api.url + url.pathname + url.search);
				return fetch(
					new Request(upstream.href, {
						method: request.method,
						headers,
						body:
							request.method === "GET" || request.method === "HEAD"
								? undefined
								: await request.text(),
					}),
				);
			}

			const path = url.pathname === "/" ? "/index.html" : url.pathname;
			const file = Bun.file(join(staticRoot, path));
			if (!(await file.exists())) {
				return new Response("not found", { status: 404 });
			}
			const ext = path.slice(path.lastIndexOf("."));
			return new Response(file, {
				headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
			});
		},
		websocket: {
			open: (socket) => {
				const upstream = socket.data;
				downstreamByUpstream.set(upstream, socket);
				for (const frame of pendingFrames.get(upstream) ?? []) {
					socket.send(frame);
				}
				pendingFrames.delete(upstream);
			},
			message: () => {
				// The console only reads over the socket; writes go over HTTP.
			},
			close: (socket) => {
				const upstream = socket.data;
				downstreamByUpstream.delete(upstream);
				pendingFrames.delete(upstream);
				upstream.close();
			},
		},
	});
	cleanups.push(async function cleanupWeb() {
		await web.stop(true);
	});
	// Pushed after the web cleanup so LIFO pops the API first: stopping the
	// proxy first strands its pooled keep-alive sockets into the API, and the
	// API's `stop(true)` then never resolves (Bun 1.3.14 socket teardown).
	cleanups.push(async function cleanupApi() {
		await api.close();
	});

	const consoleUrl = (room = "#reviews") =>
		`http://127.0.0.1:${web.port}/?token=${TOKEN}&room=${encodeURIComponent(room)}`;

	return {
		rooms,
		supervisor,
		registerPeer,
		ensureRoom,
		promptsContaining,
		consoleUrl,
	};
}

/** The store does not expose point lookup; scan known rooms for an id. */
async function findMessage(
	rooms: RoomStore,
	id: number,
): Promise<RoomMessage | undefined> {
	for (const roomId of ["#reviews", "#ops"]) {
		const found = (await rooms.listMessages(roomId, {})).find(
			(m) => m.id === id,
		);
		if (found !== undefined) return found;
	}
	return undefined;
}

// ── Rendering ────────────────────────────────────────────────────────────────
/**
 * bun's default 5s test timeout is shorter than a cold browser boot plus a
 * full render cycle; a timeout abort kills the shared browser process and
 * cascades "Connection closed" into every later test. 15s is the envelope a
 * green run of the slowest case (reconnect backoff) actually needs.
 */
const browserTest = (name: string, fn: () => Promise<void>): void => {
	test(name, fn, 20_000);
};

describe("rendering", () => {
	browserTest(
		"channels, messages, and reactions render from a live daemon",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			const posted = await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "First findings posted.",
			});
			await h.rooms.react(posted.id, "reviewer", "👀");
			await h.rooms.react(posted.id, "second-agent", "👀");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			const channels = await waitFor(
				"channel list",
				() =>
					page.$$eval("#channels .channel", (nodes) =>
						nodes.map((n) => n.textContent ?? ""),
					),
				(list) => list.length >= 2,
			);
			expect(channels.join(" ")).toContain("#reviews");
			expect(channels.join(" ")).toContain("#ops");

			await waitFor(
				"transcript",
				() => transcriptText(page),
				(t) => t.includes("First findings posted."),
			);
			expect(await renderedReactions(page, posted.id)).toEqual(["👀 2"]);
			expect(errors).toEqual([]);
		},
	);
});

// ── Posting ─────────────────────────────────────────────────────────────────

describe("posting", () => {
	browserTest(
		"a browser-posted message renders and wakes a subscribed agent",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const peer = await h.registerPeer("reviewer", ["#reviews"]);

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#composer-input");

			await page.type("#composer-input", "Ship it.");
			await page.click("#composer-send");

			await waitFor(
				"transcript",
				() => transcriptText(page),
				(t) => t.includes("Ship it."),
			);

			const prompts = await h.promptsContaining(peer.prompts, "Ship it.");
			expect(prompts.join("\n")).toContain("Ship it.");
			expect(errors).toEqual([]);
		},
	);
});

// ── Threads ─────────────────────────────────────────────────────────────────

describe("threads", () => {
	browserTest(
		"a reply renders in the thread pane and never at the channel root",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const root = await h.rooms.post({
				room: "#reviews",
				author: "@you",
				body: "Root question.",
			});
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Threaded answer.",
				parentId: root.id,
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });

			await waitFor(
				"transcript",
				() => transcriptText(page),
				(t) => t.includes("Root question."),
			);
			expect(await renderedMessages(page)).not.toContain("Threaded answer.");

			await page.click(`#messages .message[data-id="${root.id}"] .thread-open`);
			await page.waitForSelector("#thread:not([hidden])");
			const threadText = await waitFor(
				"thread pane",
				() => page.$eval("#thread", (node) => node.textContent ?? ""),
				(t) => t.includes("Threaded answer."),
			);
			expect(threadText).toContain("Threaded answer.");
			expect(await renderedMessages(page)).not.toContain("Threaded answer.");
			expect(errors).toEqual([]);
		},
	);
});

// ── Reactions ────────────────────────────────────────────────────────────────

describe("reactions", () => {
	browserTest("clicking a reaction toggles the operator's own", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "React to me.",
		});
		await h.rooms.react(posted.id, "reviewer", "👀");

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"transcript",
			() => transcriptText(page),
			(t) => t.includes("React to me."),
		);
		expect(await renderedReactions(page, posted.id)).toEqual(["👀 1"]);

		const message = () => findMessage(h.rooms, posted.id);
		const mine = async () =>
			(await message())?.reactions.some(
				(r) => r.actor === "@you" && r.emoji === "👀",
			) ?? false;

		await page.click(`#messages .message[data-id="${posted.id}"] .reaction`);
		await waitFor("operator reaction on", mine, (on) => on);
		await waitFor(
			"count 2",
			() => renderedReactions(page, posted.id),
			(chips) => chips.includes("👀 2"),
		);

		await page.click(`#messages .message[data-id="${posted.id}"] .reaction`);
		await waitFor("operator reaction off", mine, (on) => !on);
		await waitFor(
			"count 1",
			() => renderedReactions(page, posted.id),
			(chips) => chips.includes("👀 1") && !chips.includes("👀 2"),
		);
		expect(errors).toEqual([]);
	});
});

// ── Live updates and reconnect ───────────────────────────────────────────────

describe("live updates", () => {
	browserTest(
		"a message posted behind the console's back appears over the socket",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#messages");

			await h.supervisor.post({
				room: "#reviews",
				author: "reviewer",
				body: "Live agent note.",
			});
			await waitFor(
				"live message",
				() => transcriptText(page),
				(t) => t.includes("Live agent note."),
			);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"dropping and restoring the socket restores a correct transcript",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.supervisor.post({
				room: "#reviews",
				author: "@you",
				body: "Before the drop.",
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"transcript",
				() => transcriptText(page),
				(t) => t.includes("Before the drop."),
			);

			// Wait for the client to publish its socket, then sever it in-page.
			// `globalThis` keeps tsc happy in a DOM-less test file; in the page it
			// is the window.
			await page.waitForFunction(
				() =>
					Array.isArray(
						(globalThis as { __consoleSockets?: unknown[] }).__consoleSockets,
					) &&
					(
						(globalThis as { __consoleSockets?: unknown[] }).__consoleSockets ??
						[]
					).length > 0,
			);
			await page.evaluate(() => {
				const sockets = (globalThis as { __consoleSockets?: WebSocket[] })
					.__consoleSockets;
				if (sockets !== undefined) {
					for (const socket of sockets) socket.close();
				}
			});

			// Post while the console is deaf, then wait for the reconnect to
			// converge the transcript. Waiting on the rendered outcome subsumes
			// the client's real-time backoff — no fixed sleep guesses at it.
			await h.supervisor.post({
				room: "#reviews",
				author: "reviewer",
				body: "Posted during outage.",
			});
			await waitFor(
				"reconnected transcript",
				() => transcriptText(page),
				(t) =>
					t.includes("Before the drop.") && t.includes("Posted during outage."),
				10_000,
			);
			expect(errors).toEqual([]);
		},
	);
});

// ── Closing the browser stops nothing ────────────────────────────────────────

describe("detachment", () => {
	browserTest(
		"a post still wakes a subscriber after the tab is closed",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const peer = await h.registerPeer("reviewer", ["#reviews"]);

			const { page } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#messages");
			await page.close();

			await h.supervisor.post({
				room: "#reviews",
				author: "@you",
				body: "No console is watching.",
			});

			const prompts = await h.promptsContaining(
				peer.prompts,
				"No console is watching.",
			);
			expect(prompts.join("\n")).toContain("No console is watching.");
		},
	);
});
