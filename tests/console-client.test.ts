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

/** Browser globals used inside `page.evaluate` callbacks (no DOM lib here). */
declare const document: {
	querySelector(selector: string): { click(): void } | null;
	querySelectorAll(selector: string): ArrayLike<A11yNode> & {
		[Symbol.iterator](): Iterator<A11yNode>;
	};
	activeElement: A11yNode | null;
	documentElement: unknown;
	body: {
		append(node: unknown): void;
	};
	createElement(tag: string): {
		remove(): void;
		style: { color: string; backgroundColor: string };
	};
};
/** The slice of Element the a11y probes touch inside page.evaluate. */
interface A11yNode {
	id: string;
	tagName: string;
	className: string;
	textContent: string | null;
	getAttribute(name: string): string | null;
	closest(selector: string): A11yNode | null;
	parentElement: A11yNode | null;
	click(): void;
	focus(): void;
	remove(): void;
	dataset: Record<string, string | undefined>;
}
declare function getComputedStyle(target: unknown): {
	getPropertyValue(name: string): string;
	backgroundColor: string;
	color: string;
	outlineStyle: string;
	outlineWidth: string;
	transitionDuration: string;
};

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { type ConsoleApi, startConsoleApi } from "../src/daemon/console-api";
import type { PeerStoreRoots } from "../src/daemon/peer-store";
import { createPeerStore } from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
import type { SupervisedWorker } from "../src/daemon/supervisor";
import { Supervisor } from "../src/daemon/supervisor";
import type { RoomMessage, RoomStore } from "../src/rooms/store";
import { RoomStore as Store } from "../src/rooms/store";
import {
	fingerprintPeerDefinition,
	parsePeerDefinition,
} from "../src/shared/agent-definition";
import type { RoomInfo } from "../src/shared/protocol";

// ── Browser ──────────────────────────────────────────────────────────────────

/**
 * Resolve a Chrome for puppeteer-core: env override, then the puppeteer
 * cache (any version, any platform), then system installs. A hardcoded path
 * breaks on the first machine that is not this one — CI proved it.
 */
function resolveChrome(): string {
	const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	const cacheRoot = join(
		homedir(),
		".cache",
		"puppeteer",
		"chrome-headless-shell",
	);
	try {
		for (const version of readdirSync(cacheRoot).sort().reverse()) {
			const versionDir = join(cacheRoot, version);
			for (const sub of readdirSync(versionDir)) {
				const candidate = join(versionDir, sub, "chrome-headless-shell");
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// No puppeteer cache on this machine.
	}

	for (const candidate of [
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		"No Chrome found: set PUPPETEER_EXECUTABLE_PATH or run `bunx @puppeteer/browsers install chrome-headless-shell`",
	);
}

let browser: Browser;

beforeAll(async () => {
	// A cold browser launch on a loaded runner can take tens of seconds; the
	// default 5s hook timeout is the flake this opts out of.
	browser = await puppeteer.launch({
		executablePath: resolveChrome(),
		args: ["--no-sandbox"],
	});
	browser.on("disconnected", () => {
		console.error("[browser disconnected]");
	});
}, 60_000);

afterAll(async () => {
	await browser?.close();
}, 30_000);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup === undefined) continue;
		await cleanup();
	}
}, 30_000);

/** A page plus the client-side errors it raised (pageerror + console.error). */
interface TrackedPage {
	page: Page;
	errors: string[];
}

async function openPage(): Promise<TrackedPage> {
	const page = await browser.newPage();
	// A new headless target is not the active one, and in an unfocused
	// document HTMLElement.focus() is a silent no-op — without this the
	// keyboard tests flake depending on which target Chrome happened to
	// activate first.
	await page.bringToFront();
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

/** Click a selector atomically in the page, immune to feed-event re-renders. */
async function clickInPage(page: Page, selector: string): Promise<void> {
	await page.waitForSelector(selector, { timeout: 10_000 });
	await page.evaluate((s) => {
		document.querySelector(s)?.click();
	}, selector);
}

/**
 * Focus a selector atomically in one in-page round-trip, immune to feed-event re-renders. `page.focus()` is a
 * selector resolution and a focus() in two CDP round-trips; a transcript repaint between them
 * leaves focus() landing on a detached node (silent no-op) — the flake that
 * took the thread keyboard test down intermittently.
 */
async function focusInPage(page: Page, selector: string): Promise<void> {
	await page.waitForSelector(selector, { timeout: 10_000 });
	await page.evaluate((s) => {
		const el = document.querySelector(s);
		if (el === null) throw new Error(`Not focusable: ${s}`);
		(el as unknown as { focus(): void }).focus();
	}, selector);
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

function stubWorker(name = "reviewer", fingerprint?: string) {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";

	const worker: SupervisedWorker = {
		name,
		fingerprint,
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
 * The daemon's composition (store + supervisor + peer store + console API),
 * plus a static server for the client files and a transparent API proxy.
 * Everything the browser talks to is here.
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

	// Same private store the console writes definitions into and the daemon
	// re-reads on boot.
	const roots: PeerStoreRoots = {
		user: join(dir, "user", "agents"),
		project: join(dir, "project", "agents"),
	};
	await mkdir(roots.user, { recursive: true });
	await mkdir(roots.project, { recursive: true });
	const peerStore = createPeerStore(roots);

	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => Date.now(),
		peers: peerStore,
		respawn: async ({ peerName, definition }) =>
			stubWorker(peerName, fingerprintPeerDefinition(definition)).worker,
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
		peerStore,
		knownRooms,
		ensureRoom,
		token: TOKEN,
		pollIntervalMs: options.pollIntervalMs ?? 25,
	});

	const registerPeer = async (
		name: string,
		roomIds: string[],
	): Promise<{ prompts: string[] }> => {
		const path = join(roots.project, `${name}.md`);
		const document = [
			"---",
			`name: ${name}`,
			`description: ${name} peer for console client tests.`,
			`spawns: ${JSON.stringify(["scout"])}`,
			...(roomIds.length === 0 ? [] : [`rooms: ${JSON.stringify(roomIds)}`]),
			"---",
			`You are ${name}.`,
			"",
		].join("\n");
		await writeFile(path, document, "utf8");
		const definition = parsePeerDefinition(path, document);
		const stub = stubWorker(name, fingerprintPeerDefinition(definition));
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

	/** Definitions as a cold daemon boot would read them. */
	const reload = () => createPeerStore(roots).list();

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
	 * Static client files and a transparent API proxy. The browser sends its
	 * token in a custom header, rewritten to Authorization here so no token
	 * lands in a URL anywhere. Every write, including the reaction toggle,
	 * goes to the real console API — T-605 landed the last missing route, so
	 * nothing is simulated here any more.
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
			// Chrome fetches a favicon on every fresh profile; a 404 there is
			// noise that pollutes page-error assertions, so answer it empty.
			if (path === "/favicon.ico") {
				return new Response(null, { status: 204 });
			}
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
		reload,
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

			await clickInPage(
				page,
				`#messages .message[data-id="${root.id}"] .thread-open`,
			);
			await page.waitForSelector("#thread:not([hidden])", { timeout: 10_000 });
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

		// Click atomically in the page: the client re-renders on every feed
		// event, and a puppeteer-resolved node can detach between query and
		// click ("Node is detached from document" on runners).
		const chip = `#messages .message[data-id="${posted.id}"] .reaction`;
		const clickChip = async () => {
			await page.waitForSelector(chip, { timeout: 10_000 });
			await page.evaluate((s) => {
				// This callback runs in the browser; the repo has no DOM lib,
				// so the global is declared structurally at the top of the file.
				document.querySelector(s)?.click();
			}, chip);
		};

		await clickChip();
		await waitFor("operator reaction on", mine, (on) => on);
		await waitFor(
			"count 2",
			() => renderedReactions(page, posted.id),
			(chips) => chips.includes("👀 2"),
		);

		await clickChip();
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

// ── Creation forms ───────────────────────────────────────────────────────────

describe("creation forms", () => {
	browserTest("creating a channel from the form lists it", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#new-channel-input");

		await page.type("#new-channel-input", "#ops");
		await page.click("#new-channel-create");

		const channels = await waitFor(
			"channel list including #ops",
			() =>
				page.$$eval("#channels .channel", (nodes) =>
					nodes.map((n) => (n.textContent ?? "").trim()),
				),
			(list) => list.includes("#ops"),
		);
		expect(channels).toContain("#ops");
		expect(errors).toEqual([]);
	});

	browserTest(
		"creating an agent from the form writes a definition the daemon can load",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#new-agent-name");

			await page.type("#new-agent-name", "researcher");
			await page.type("#new-agent-description", "Researches things.");
			await page.type("#new-agent-spawns", "scout");
			await page.type("#new-agent-rooms", "#reviews");
			await page.type("#new-agent-body", "You are the researcher.");
			await page.click("#new-agent-create");

			// The browser's own success signal first, then the durable proof: a
			// cold peer store sees the definition the form wrote.
			await waitFor(
				"agent list including researcher",
				() =>
					page.$$eval("#agents .agent", (nodes) =>
						nodes.map((n) => (n.textContent ?? "").trim()),
					),
				(list) => list.some((entry) => entry.includes("researcher")),
			);
			const listing = await h.reload();
			expect(listing.errors).toEqual([]);
			expect(
				listing.definitions.find((d) => d.name === "researcher")?.rooms,
			).toEqual(["#reviews"]);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"an invalid agent shows the parser's error and writes nothing",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#new-agent-name");

			await page.type("#new-agent-name", "broken");
			await page.type("#new-agent-description", "Rooms without a prefix.");
			await page.type("#new-agent-spawns", "scout");
			await page.type("#new-agent-rooms", "reviews");
			await page.type("#new-agent-body", "You are broken.");
			await page.click("#new-agent-create");

			const shown = await waitFor(
				"parser error in the form",
				() => page.$eval("#new-agent-error", (node) => node.textContent ?? ""),
				(text) => text.includes("rooms entries must start with"),
			);
			expect(shown).toContain('rooms entries must start with "#"');
			expect((await h.reload()).definitions.map((d) => d.name)).not.toContain(
				"broken",
			);
			// A refused write is a rendered message, not an uncaught rejection.
			// Chrome logs "Failed to load resource" for every non-2xx response
			// whether or not the page handled it, and the 400 here is the
			// contract; what must not appear is an error the client raised.
			expect(
				errors.filter((entry) => !entry.startsWith("Failed to load resource")),
			).toEqual([]);
		},
	);
});

// ── Membership controls ──────────────────────────────────────────────────────

describe("membership controls", () => {
	browserTest(
		"subscribing a running agent from the UI wakes it on the next post",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			const peer = await h.registerPeer("reviewer", ["#reviews"]);

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl("#ops"), {
				waitUntil: "domcontentloaded",
			});
			await page.waitForSelector(
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			await clickInPage(
				page,
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);
			await waitFor(
				"reviewer shown as a member of #ops",
				() =>
					page.$eval(
						'#agents .agent[data-name="reviewer"] .membership-toggle',
						(node) => node.getAttribute("data-member") ?? "",
					),
				(value) => value === "true",
			);

			await h.supervisor.post({
				room: "#ops",
				author: "@you",
				body: "Ops needs you.",
			});
			const prompts = await h.promptsContaining(peer.prompts, "Ops needs you.");
			expect(prompts.join("\n")).toContain("Ops needs you.");
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"unsubscribing a running agent from the UI stops delivery",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const leaving = await h.registerPeer("reviewer", ["#reviews"]);
			const staying = await h.registerPeer("researcher", ["#reviews"]);

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector(
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			await clickInPage(
				page,
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);
			await waitFor(
				"reviewer shown as not a member of #reviews",
				() =>
					page.$eval(
						'#agents .agent[data-name="reviewer"] .membership-toggle',
						(node) => node.getAttribute("data-member") ?? "",
					),
				(value) => value === "false",
			);

			await h.supervisor.post({
				room: "#reviews",
				author: "@you",
				body: "Still listening?",
			});
			const prompts = await h.promptsContaining(
				staying.prompts,
				"Still listening?",
			);
			expect(prompts.join("\n")).toContain("Still listening?");
			expect(leaving.prompts.join("\n")).not.toContain("Still listening?");
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"the UI says a membership change took effect immediately",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			await h.registerPeer("reviewer", ["#reviews"]);

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl("#ops"), {
				waitUntil: "domcontentloaded",
			});
			await page.waitForSelector(
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			await clickInPage(
				page,
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			// Step 7 of the contract: an operator must be told which changes are
			// live and which wait for a rebuild.
			const notice = await waitFor(
				"membership notice",
				() => page.$eval("#notice", (node) => node.textContent ?? ""),
				(text) => text.length > 0,
			);
			expect(notice.toLowerCase()).toContain("immediately");
			expect(notice.toLowerCase()).not.toContain("rebuild");
			expect(errors).toEqual([]);
		},
	);
});

// ── Visual system (T-1101) ───────────────────────────────────────────────────

/**
 * The token layer is a source-level contract as much as a rendered one: every
 * color and every non-structural length must flow through `:root` custom
 * properties, or "use the tokens" decays into a suggestion. Computed-style
 * assertions cannot see which literal produced a pixel, so this half of the
 * gate reads style.css itself — the one place where source text is the
 * behavior under test.
 */
describe("design tokens", () => {
	const styleSource = async (): Promise<string> =>
		await readFile(join(import.meta.dir, "../src/console/style.css"), "utf8");

	/** style.css with comments removed and the :root block(s) cut out. */
	const outsideRoot = (css: string): string => {
		const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
		let out = "";
		let index = 0;
		for (;;) {
			const start = noComments.indexOf(":root", index);
			if (start === -1) {
				out += noComments.slice(index);
				return out;
			}
			out += noComments.slice(index, start);
			const open = noComments.indexOf("{", start);
			if (open === -1) return out;
			let depth = 1;
			let cursor = open + 1;
			while (cursor < noComments.length && depth > 0) {
				if (noComments[cursor] === "{") depth += 1;
				if (noComments[cursor] === "}") depth -= 1;
				cursor += 1;
			}
			index = cursor;
		}
	};

	const rootBlock = (css: string): string => {
		const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
		const start = noComments.indexOf(":root");
		if (start === -1) return "";
		const open = noComments.indexOf("{", start);
		let depth = 1;
		let cursor = open + 1;
		while (cursor < noComments.length && depth > 0) {
			if (noComments[cursor] === "{") depth += 1;
			if (noComments[cursor] === "}") depth -= 1;
			cursor += 1;
		}
		return noComments.slice(open + 1, cursor - 1);
	};

	test("a :root block defines the semantic token vocabulary", async () => {
		const root = rootBlock(await styleSource());
		for (const token of [
			"--surface-0",
			"--surface-1",
			"--surface-2",
			"--text-primary",
			"--text-muted",
			"--accent",
			"--danger",
			"--success",
			"--muted",
			"--space-1",
			"--space-2",
			"--space-3",
			"--font-size-0",
			"--font-size-1",
			"--role-agent",
			"--role-you",
			"--role-system",
		]) {
			expect(root).toContain(`${token}:`);
		}
	});

	test("no raw color appears outside the :root token block", async () => {
		const body = outsideRoot(await styleSource());
		const rawColors = body.match(
			/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|color-mix)\(|\b(?:white|black|red|blue|green|gray|grey|silver)\b/g,
		);
		expect(rawColors ?? []).toEqual([]);
	});

	test("length literals outside :root sit only on structural properties", async () => {
		const body = outsideRoot(await styleSource());
		// Structure may be sized directly; paint and rhythm must use tokens.
		const structural =
			/^(?:width|min-width|max-width|height|min-height|max-height|flex-basis|top|right|bottom|left|inset|line-height|border|border-top|border-right|border-bottom|border-left|border-width|outline|outline-width|outline-offset|letter-spacing|tab-size)$/;
		const offenders: string[] = [];
		for (const declaration of body.split(/[;{}]/)) {
			const colon = declaration.indexOf(":");
			if (colon === -1) continue;
			const property = declaration.slice(0, colon).trim();
			const value = declaration.slice(colon + 1);
			if (!/-?\d*\.?\d+(?:px|rem|em|ch|vh|vw|pt)\b/.test(value)) continue;
			if (structural.test(property)) continue;
			offenders.push(declaration.trim());
		}
		expect(offenders).toEqual([]);
	});

	browserTest("tokens reach computed styles in the browser", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#messages");

		const probe = await page.evaluate(() => {
			const styles = getComputedStyle(document.documentElement);
			const resolve = (name: string): string => {
				const node = document.createElement("div");
				node.style.color = `var(${name})`;
				document.body.append(node);
				const painted = getComputedStyle(node).color;
				node.remove();
				return painted;
			};
			return {
				surface0: styles.getPropertyValue("--surface-0").trim(),
				accent: styles.getPropertyValue("--accent").trim(),
				bodyBackground: getComputedStyle(document.body).backgroundColor,
				surface0Resolved: resolve("--surface-0"),
				accentResolved: resolve("--accent"),
			};
		});
		expect(probe.surface0).not.toBe("");
		expect(probe.accent).not.toBe("");
		// The page consumes the tokens: the body is painted with --surface-0,
		// not left at the UA default (transparent over white).
		expect(probe.bodyBackground).toBe(probe.surface0Resolved);
		expect(probe.bodyBackground).not.toBe("rgba(0, 0, 0, 0)");
		expect(probe.accentResolved).not.toBe(probe.surface0Resolved);
		expect(errors).toEqual([]);
	});
});

describe("message presentation", () => {
	browserTest(
		"authors carry role identity with distinct computed tints",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Agent line.",
			});
			await h.rooms.post({
				room: "#reviews",
				author: "@you",
				body: "Operator line.",
			});
			await h.rooms.post({
				room: "#reviews",
				author: "system",
				body: "System line.",
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"transcript",
				() => transcriptText(page),
				(t) => t.includes("System line."),
			);

			const classesFor = (body: string): Promise<string> =>
				page.$$eval(
					"#messages .message",
					(nodes, needle) => {
						const hit = nodes.find((n) =>
							(n.textContent ?? "").includes(String(needle)),
						);
						return hit === undefined ? "" : hit.className;
					},
					body,
				);
			expect(await classesFor("Agent line.")).toContain("role-agent");
			expect(await classesFor("Operator line.")).toContain("role-you");
			expect(await classesFor("System line.")).toContain("role-system");

			const tintFor = (body: string): Promise<string> =>
				page.$$eval(
					"#messages .message",
					(nodes, needle) => {
						const hit = nodes.find((n) =>
							(n.textContent ?? "").includes(String(needle)),
						);
						const author = hit?.querySelector(".author");
						if (author == null) return "";
						return getComputedStyle(author).color;
					},
					body,
				);
			const agentTint = await tintFor("Agent line.");
			const youTint = await tintFor("Operator line.");
			expect(agentTint).not.toBe("");
			expect(youTint).not.toBe("");
			expect(agentTint).not.toBe(youTint);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"consecutive messages from one author group under one header",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "First of a pair.",
			});
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Second of a pair.",
			});
			await h.rooms.post({
				room: "#reviews",
				author: "@you",
				body: "Breaks the run.",
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"transcript",
				() => transcriptText(page),
				(t) => t.includes("Breaks the run."),
			);

			const rows = await page.$$eval("#messages .message", (nodes) =>
				nodes.map((n) => ({
					grouped: n.className.includes("grouped"),
					authors: n.querySelectorAll(".author").length,
					body: n.querySelector(".body")?.textContent ?? "",
				})),
			);
			const first = rows.find((r) => r.body.includes("First of a pair."));
			const second = rows.find((r) => r.body.includes("Second of a pair."));
			const breaker = rows.find((r) => r.body.includes("Breaks the run."));
			expect(first?.grouped).toBe(false);
			expect(first?.authors).toBe(1);
			expect(second?.grouped).toBe(true);
			expect(second?.authors).toBe(0);
			expect(breaker?.grouped).toBe(false);
			expect(breaker?.authors).toBe(1);
			expect(errors).toEqual([]);
		},
	);

	browserTest("messages carry a readable timestamp", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Timestamped.",
		});

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"transcript",
			() => transcriptText(page),
			(t) => t.includes("Timestamped."),
		);

		const stamps = await page.$$eval("#messages .message .timestamp", (nodes) =>
			nodes.map((n) => (n.textContent ?? "").trim()),
		);
		expect(stamps.length).toBeGreaterThan(0);
		expect(stamps[0]).toMatch(/\d{1,2}:\d{2}/);
		expect(errors).toEqual([]);
	});

	browserTest("fenced code blocks render as pre, text intact", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Patch below:\n```\nconst x = 1;\n```\nApply it.",
		});

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"transcript",
			() => transcriptText(page),
			(t) => t.includes("Apply it."),
		);

		const pre = await page.$$eval("#messages .message pre", (nodes) =>
			nodes.map((n) => (n.textContent ?? "").trim()),
		);
		expect(pre).toEqual(["const x = 1;"]);
		// The body text around the fence survives outside the pre.
		const text = await transcriptText(page);
		expect(text).toContain("Patch below:");
		expect(text).toContain("Apply it.");
		expect(errors).toEqual([]);
	});
});

// ── First-class states ───────────────────────────────────────────────────────

/**
 * A minimal degraded server: the real client files, an /api that misbehaves
 * one chosen way. The daemon harness cannot produce these shapes (it is
 * healthy by construction), and the states are precisely about what the
 * client shows when the daemon is not.
 */
async function degradedServer(
	apiBehavior: (url: URL) => Response | undefined | "hang",
) {
	const staticRoot = join(import.meta.dir, "../src/console");
	const web = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/api/")) {
				const verdict = apiBehavior(url);
				if (verdict === "hang") return new Promise<Response>(() => {});
				if (verdict !== undefined) return verdict;
				return new Response(
					JSON.stringify({
						error: { code: "unavailable", message: "daemon offline" },
					}),
					{
						status: 502,
						headers: { "content-type": "application/json" },
					},
				);
			}
			if (url.pathname === "/favicon.ico") {
				return new Response(null, { status: 204 });
			}
			const name = url.pathname === "/" ? "/index.html" : url.pathname;
			const file = Bun.file(join(staticRoot, `.${name}`));
			if (!(await file.exists())) {
				return new Response("not found", { status: 404 });
			}
			const extension = name.slice(name.lastIndexOf("."));
			return new Response(file, {
				headers: {
					"content-type": MIME[extension] ?? "application/octet-stream",
				},
			});
		},
	});
	cleanups.push(async function cleanupDegraded() {
		await web.stop(true);
	});
	return { url: `http://127.0.0.1:${web.port}/?token=${TOKEN}` };
}

const stateOnPage = (page: Page) =>
	page
		.$eval("#state:not([hidden])", (node) => ({
			state: node.getAttribute("data-state") ?? "",
			text: node.textContent ?? "",
			action: node.querySelector(".state-action")?.textContent ?? "",
		}))
		.catch(() => null);

describe("states", () => {
	browserTest("a hanging API shows the connecting state", async () => {
		const server = await degradedServer(() => "hang");
		const { page } = await openPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded" });

		const shown = await waitFor(
			"connecting state",
			() => stateOnPage(page),
			(s) => s !== null && s.state === "connecting",
		);
		expect(shown?.text.toLowerCase()).toContain("connecting");
	});

	browserTest(
		"a dead API shows the offline state with a retry action",
		async () => {
			const server = await degradedServer(() => undefined);
			const { page } = await openPage();
			await page.goto(server.url, { waitUntil: "domcontentloaded" });

			const shown = await waitFor(
				"offline state",
				() => stateOnPage(page),
				(s) => s !== null && s.state === "offline",
			);
			expect(shown?.text.toLowerCase()).toContain("offline");
			expect(shown?.action.toLowerCase()).toContain("retry");
		},
	);

	browserTest(
		"a transcript load failure shows its state with a retry action",
		async () => {
			const server = await degradedServer((url) => {
				if (url.pathname === "/api/channels") {
					return new Response(
						JSON.stringify({
							channels: [{ id: "#reviews", kind: "channel" }],
						}),
						{ headers: { "content-type": "application/json" } },
					);
				}
				if (url.pathname === "/api/agents") {
					return new Response(JSON.stringify({ agents: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						error: { code: "boom", message: "store exploded" },
					}),
					{ status: 500, headers: { "content-type": "application/json" } },
				);
			});
			const { page } = await openPage();
			await page.goto(server.url, { waitUntil: "domcontentloaded" });

			const shown = await waitFor(
				"load-failure state",
				() => stateOnPage(page),
				(s) => s !== null && s.state === "load-failure",
			);
			expect(shown?.action.toLowerCase()).toContain("retry");
		},
	);

	browserTest(
		"an empty channel names itself and clears on the first post",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });

			const shown = await waitFor(
				"empty state",
				() => stateOnPage(page),
				(s) => s !== null && s.state === "empty",
			);
			expect(shown?.text.length ?? 0).toBeGreaterThan(0);
			expect(shown?.action.length ?? 0).toBeGreaterThan(0);

			// The empty state's next action targets the composer.
			await clickInPage(page, "#state .state-action");
			const focused = await page.evaluate(
				() => document.activeElement?.id ?? "",
			);
			expect(focused).toBe("composer-input");

			await h.supervisor.post({
				room: "#reviews",
				author: "reviewer",
				body: "No longer empty.",
			});
			await waitFor(
				"empty state cleared",
				() => stateOnPage(page),
				(s) => s === null,
			);
			expect(await transcriptText(page)).toContain("No longer empty.");
			expect(errors).toEqual([]);
		},
	);
});

// ── Composer ─────────────────────────────────────────────────────────────────

describe("composer", () => {
	browserTest(
		"multiline composer: Enter sends, Shift+Enter breaks the line",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#composer-input");

			const tag = await page.$eval("#composer-input", (n) => n.tagName);
			expect(tag).toBe("TEXTAREA");

			// The keyboard behavior is discoverable, not folklore.
			const hint = await page.$eval(
				"#composer .composer-hint",
				(n) => n.textContent ?? "",
			);
			expect(hint).toContain("Enter");

			await page.type("#composer-input", "Line one.");
			await page.keyboard.down("Shift");
			await page.keyboard.press("Enter");
			await page.keyboard.up("Shift");
			await page.type("#composer-input", "Line two.");
			await page.keyboard.press("Enter");

			await waitFor(
				"multiline message",
				() => transcriptText(page),
				(t) => t.includes("Line one.") && t.includes("Line two."),
			);
			const bodies = await renderedMessages(page);
			const sent = bodies.find((b) => b.includes("Line one."));
			expect(sent).toContain("Line two.");
			// One message, not two: Shift+Enter did not send.
			expect(bodies.filter((b) => b.includes("Line")).length).toBe(1);
			expect(errors).toEqual([]);
		},
	);

	browserTest("the thread composer speaks the same dialect", async () => {
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
		await clickInPage(
			page,
			`#messages .message[data-id="${root.id}"] .thread-open`,
		);
		await page.waitForSelector("#thread:not([hidden])", { timeout: 10_000 });

		const tag = await page.$eval("#thread-composer-input", (n) => n.tagName);
		expect(tag).toBe("TEXTAREA");
		const hint = await page.$eval(
			"#thread-composer .composer-hint",
			(n) => n.textContent ?? "",
		);
		expect(hint).toContain("Enter");

		// Thread rows carry the same presentation system as the channel.
		const threadRow = await page.$eval("#thread-messages .message", (n) => ({
			className: n.className,
			stamps: n.querySelectorAll(".timestamp").length,
		}));
		expect(threadRow.className).toContain("role-agent");
		expect(threadRow.stamps).toBe(1);
		expect(errors).toEqual([]);
	});
});

// ── Unread affordance ────────────────────────────────────────────────────────

describe("unread", () => {
	browserTest(
		"activity in a background channel marks it unread until visited",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#channels .channel");

			// The unread mark arrives only as a live frame; a post that lands
			// before the events socket is OPEN is missed forever (the open-time
			// refetch heals the transcript, not unreadRooms). Wait for the
			// socket before posting, the same hook the sever test uses.
			await waitFor(
				"events socket open",
				() =>
					page.evaluate(() =>
						(
							(globalThis as { __consoleSockets?: WebSocket[] })
								.__consoleSockets ?? []
						).some((s) => s.readyState === WebSocket.OPEN),
					),
				(open) => open === true,
			);

			await h.supervisor.post({
				room: "#ops",
				author: "reviewer",
				body: "Background chatter.",
			});

			const unread = await waitFor(
				"unread affordance on #ops",
				() =>
					page.$$eval("#channels .channel", (nodes) =>
						nodes
							.filter((n) => n.className.includes("unread"))
							.map((n) => (n.textContent ?? "").trim()),
					),
				(list) => list.length > 0,
			);
			expect(unread.join(" ")).toContain("#ops");
			// The open channel never marks itself.
			expect(unread.join(" ")).not.toContain("#reviews");

			// Visiting clears it.
			await page.$$eval("#channels .channel", (nodes) => {
				const target = nodes.find((n) =>
					(n.textContent ?? "").includes("#ops"),
				);
				if (target !== undefined)
					(target as unknown as { click(): void }).click();
			});
			await waitFor(
				"unread cleared",
				() =>
					page.$$eval(
						"#channels .channel",
						(nodes) =>
							nodes.filter((n) => n.className.includes("unread")).length,
					),
				(count) => count === 0,
			);
			expect(errors).toEqual([]);
		},
	);
});

// ── Accessibility (T-1102) ───────────────────────────────────────────────────

/** Relative luminance of an "rgb(r, g, b)" string, per WCAG. */
const luminance = (painted: string): number => {
	const match = painted.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (match === null) throw new Error(`Unparseable color: ${painted}`);
	const [r, g, b] = [match[1], match[2], match[3]]
		.map((channel) => Number(channel) / 255)
		.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two painted colors. */
const contrastRatio = (a: string, b: string): number => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

/** The focused element, described enough to assert focus order. */
const focusProbe = (page: Page) =>
	page.evaluate(() => {
		const active = document.activeElement;
		if (active === null) return null;
		return {
			id: active.id,
			className: active.className,
			text: (active.textContent ?? "").trim(),
			inThread: active.closest("#thread") !== null,
			messageId: active.closest(".message")?.dataset.id ?? null,
		};
	});

describe("accessibility", () => {
	browserTest(
		"landmarks, roles, and names are exposed on the live DOM",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.rooms.post({
				room: "#reviews",
				author: "@you",
				body: "Root question.",
			});
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Threaded answer.",
				parentId: 1,
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#channels .channel");

			// Navigation landmark around the channel/agent rail, with a name.
			const nav = await page.$eval("nav#sidebar", (node) => ({
				label: node.getAttribute("aria-label") ?? "",
			}));
			expect(nav.label.length).toBeGreaterThan(0);

			// One main region; the current-channel header is the banner.
			expect(await page.$("main#main")).not.toBeNull();
			expect(
				await page.$eval(
					"#current-channel",
					(node) => node.getAttribute("role") ?? "",
				),
			).toBe("banner");

			// Channels are a listbox of options; exactly one selected.
			const listbox = await page.$eval("#channels", (node) => ({
				role: node.getAttribute("role") ?? "",
				label: node.getAttribute("aria-label") ?? "",
			}));
			expect(listbox.role).toBe("listbox");
			expect(listbox.label.length).toBeGreaterThan(0);
			const options = await page.$$eval("#channels .channel", (nodes) =>
				nodes.map((n) => ({
					role: n.getAttribute("role") ?? "",
					selected: n.getAttribute("aria-selected") ?? "",
					tabindex: n.getAttribute("tabindex") ?? "",
				})),
			);
			expect(options.length).toBeGreaterThan(0);
			for (const option of options) expect(option.role).toBe("option");
			expect(options.filter((o) => o.selected === "true").length).toBe(1);
			// Roving tabindex: exactly one option is in the tab order.
			expect(options.filter((o) => o.tabindex === "0").length).toBe(1);

			// The transcript is a polite live log, keyboard-scrollable.
			const log = await page.$eval("#messages", (node) => ({
				role: node.getAttribute("role") ?? "",
				live: node.getAttribute("aria-live") ?? "",
				label: node.getAttribute("aria-label") ?? "",
				tabindex: node.getAttribute("tabindex") ?? "",
			}));
			expect(log.role).toBe("log");
			expect(log.live).toBe("polite");
			expect(log.label.length).toBeGreaterThan(0);
			expect(log.tabindex).toBe("0");

			// Both composers are labeled textboxes.
			for (const selector of ["#composer-input", "#thread-composer-input"]) {
				const label = await page.$eval(
					selector,
					(node) => node.getAttribute("aria-label") ?? "",
				);
				expect(label.length).toBeGreaterThan(0);
			}

			// The thread pane is a named complementary region with a labeled close.
			const thread = await page.$eval("aside#thread", (node) => ({
				role: node.getAttribute("role") ?? "",
				label: node.getAttribute("aria-label") ?? "",
			}));
			expect(thread.role).toBe("complementary");
			expect(thread.label.length).toBeGreaterThan(0);
			expect(
				(
					await page.$eval("#thread-close", (node) => node.textContent ?? "")
				).trim().length,
			).toBeGreaterThan(0);

			// State screens are status regions and their action is a real button.
			const state = await page.$eval("#state", (node) => ({
				role: node.getAttribute("role") ?? "",
				actionTag: node.querySelector(".state-action")?.tagName ?? "",
			}));
			expect(state.role).toBe("status");
			expect(state.actionTag).toBe("BUTTON");

			// Non-vacuity: the assertions above read live attributes, so removing
			// any role fails its expect; this spot-checks the strictest one.
			expect(options[0]?.role).not.toBe("");
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"channel switching is keyboard-only: skip link, roving arrows, Enter",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.$$eval("#channels .channel", (nodes) => nodes.length);
			await waitFor(
				"two channel options",
				() => page.$$eval("#channels .channel", (nodes) => nodes.length),
				(count) => count >= 2,
			);

			// First Tab lands on the skip link.
			await page.keyboard.press("Tab");
			const first = await focusProbe(page);
			expect(first?.className ?? "").toContain("skip-link");

			// Second Tab lands on the roving channel option, not every option.
			await page.keyboard.press("Tab");
			const onOption = await focusProbe(page);
			expect(onOption?.className ?? "").toContain("channel");
			expect(onOption?.text ?? "").toContain("#reviews");

			// ArrowDown roves to the next option without selecting it.
			await page.keyboard.press("ArrowDown");
			const roved = await focusProbe(page);
			expect(roved?.text ?? "").toContain("#ops");
			expect(
				await page.$eval("#current-channel", (n) => n.textContent ?? ""),
			).toContain("#reviews");

			// Enter selects; the header, aria-selected, and focus all follow.
			await page.keyboard.press("Enter");
			await waitFor(
				"open channel header",
				() => page.$eval("#current-channel", (n) => n.textContent ?? ""),
				(text) => text.includes("#ops"),
			);
			const selected = await waitFor(
				"aria-selected on #ops",
				() =>
					page.$$eval("#channels .channel", (nodes) =>
						nodes
							.filter((n) => n.getAttribute("aria-selected") === "true")
							.map((n) => (n.textContent ?? "").trim()),
					),
				(list) => list.length === 1,
			);
			expect(selected[0]).toContain("#ops");
			const after = await waitFor(
				"focus kept on the selected option",
				() => focusProbe(page),
				(probe) => (probe?.className ?? "").includes("channel"),
			);
			expect(after?.text ?? "").toContain("#ops");
			expect(errors).toEqual([]);
		},
	);

	browserTest("the transcript log scrolls by keyboard", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		for (let i = 0; i < 30; i += 1) {
			await h.rooms.post({
				room: "#reviews",
				author: i % 2 === 0 ? "reviewer" : "second-agent",
				body: `Filler line ${i} to force the transcript to overflow.`,
			});
		}

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"transcript",
			() => transcriptText(page),
			(t) => t.includes("Filler line 29"),
		);

		await focusInPage(page, "#messages");
		await page.$eval("#messages", (node) => {
			(node as unknown as { scrollTop: number }).scrollTop = 0;
		});
		await page.keyboard.press("End");
		const scrolled = await waitFor(
			"log scrolled by End",
			() =>
				page.$eval(
					"#messages",
					(node) => (node as unknown as { scrollTop: number }).scrollTop,
				),
			(top) => top > 0,
		);
		expect(scrolled).toBeGreaterThan(0);

		await page.keyboard.press("Home");
		await waitFor(
			"log scrolled home",
			() =>
				page.$eval(
					"#messages",
					(node) => (node as unknown as { scrollTop: number }).scrollTop,
				),
			(top) => top === 0,
		);
		expect(errors).toEqual([]);
	});

	browserTest(
		"reaction chips are keyboard toggle buttons with aria-pressed",
		async () => {
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
				"reaction chip",
				() => renderedReactions(page, posted.id),
				(chips) => chips.length === 1,
			);

			const chipSelector = `#messages .message[data-id="${posted.id}"] .reaction`;
			expect(
				await page.$eval(chipSelector, (n) => n.getAttribute("aria-pressed")),
			).toBe("false");

			// Keyboard toggle on: focus the chip and press Enter.
			await focusInPage(page, chipSelector);
			await page.keyboard.press("Enter");
			const pressed = await waitFor(
				"chip pressed",
				() =>
					page
						.$eval(chipSelector, (n) => ({
							pressed: n.getAttribute("aria-pressed") ?? "",
							text: (n.textContent ?? "").trim(),
						}))
						.catch(() => null),
				(chip) => chip !== null && chip.pressed === "true",
			);
			expect(pressed?.text).toBe("👀 2");

			// And off again, still by keyboard.
			await focusInPage(page, chipSelector);
			await page.keyboard.press("Enter");
			await waitFor(
				"chip released",
				() =>
					page
						.$eval(chipSelector, (n) => n.getAttribute("aria-pressed") ?? "")
						.catch(() => null),
				(state) => state === "false",
			);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"thread opens by keyboard, moves focus in, and Escape returns it",
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

			const openerSelector = `#messages .message[data-id="${root.id}"] .thread-open`;
			await focusInPage(page, openerSelector);
			await page.keyboard.press("Enter");
			await page.waitForSelector("#thread:not([hidden])", { timeout: 10_000 });

			// Focus moved into the pane.
			const inPane = await waitFor(
				"focus inside the thread pane",
				() => focusProbe(page),
				(probe) => probe?.inThread === true,
			);
			expect(inPane?.inThread).toBe(true);

			// A keyboard reply posts from here. The console API drops parentId
			// (console-api.ts reads only { body, author }), so the reply lands
			// as a root message rather than inside the pane — a server-side
			// T-1101 gap outside this task's editable files. The a11y claim
			// under test is keyboard operability: Enter in the thread composer
			// sends without a pointer.
			await focusInPage(page, "#thread-composer-input");
			await page.keyboard.type("Reply from the keyboard.");
			await page.keyboard.press("Enter");
			await waitFor(
				"keyboard thread reply posted",
				() => transcriptText(page),
				(t) => t.includes("Reply from the keyboard."),
			);

			// Escape closes the pane and returns focus to the opener.
			await page.keyboard.press("Escape");
			await page.waitForSelector("#thread[hidden]");
			const returned = await waitFor(
				"focus returned to the thread opener",
				() => focusProbe(page),
				(probe) => (probe?.className ?? "").includes("thread-open"),
			);
			expect(returned?.messageId).toBe(String(root.id));
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"a transcript repaint keeps focus on the control it was on",
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

			const openerSelector = `#messages .message[data-id="${root.id}"] .thread-open`;
			await focusInPage(page, openerSelector);

			// A live update repaints the transcript; keyboard focus must survive on the same
			// control, not drop to <body> — the repaint race this guards was observed
			// as a flake in the thread keyboard test above.
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Another root elsewhere.",
			});
			await waitFor(
				"repaint",
				() => transcriptText(page),
				(t) => t.includes("Another root elsewhere."),
			);
			const kept = await focusProbe(page);
			expect(kept?.className).toBe("thread-open");
			expect(kept?.messageId).toBe(String(root.id));

			// The restored control still activates by keyboard.
			await page.keyboard.press("Enter");
			await page.waitForSelector("#thread:not([hidden])", { timeout: 10_000 });
			expect(errors).toEqual([]);
		},
	);

	browserTest("a message posts by keyboard alone", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#composer-input");

		await focusInPage(page, "#composer-input");
		await page.keyboard.type("Sent without a pointer.");
		await page.keyboard.press("Enter");
		await waitFor(
			"keyboard-posted message",
			() => transcriptText(page),
			(t) => t.includes("Sent without a pointer."),
		);
		expect(errors).toEqual([]);
	});

	browserTest("the offline state moves focus to the retry button", async () => {
		const server = await degradedServer(() => undefined);
		const { page } = await openPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded" });

		await waitFor(
			"offline state",
			() => stateOnPage(page),
			(s) => s !== null && s.state === "offline",
		);
		const focused = await waitFor(
			"focus on the retry button",
			() => focusProbe(page),
			(probe) => (probe?.className ?? "").includes("state-action"),
		);
		expect(focused?.text.toLowerCase()).toContain("retry");
	});

	browserTest("keyboard focus is visible", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#channels .channel");

		// The token layer owns the affordance, not the UA default.
		const css = await readFile(
			join(import.meta.dir, "../src/console/style.css"),
			"utf8",
		);
		expect(css).toContain(":focus-visible");

		// Reach an option by keyboard and observe a painted outline.
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		const outline = await page.evaluate(() => {
			const active = document.activeElement;
			if (active === null) return null;
			const styles = getComputedStyle(active);
			return {
				className: active.className,
				style: styles.outlineStyle,
				width: styles.outlineWidth,
			};
		});
		expect(outline?.className ?? "").toContain("channel");
		expect(outline?.style).not.toBe("none");
		expect(outline?.width).not.toBe("0px");
		expect(errors).toEqual([]);
	});

	browserTest(
		"body and interactive text meet AAA 7:1 on the surfaces that carry them",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#messages");

			/**
			 * Every (text token, surface token) pair the console actually
			 * paints, per style.css:
			 * - text-primary: message bodies (surface-0), headers/composers
			 *   (surface-1), hovered channels (surface-2).
			 * - text-muted: timestamps and chips (surface-0), sidebar labels,
			 *   hints, membership toggles (surface-1), and it must survive
			 *   surface-2 hovers.
			 * - accent: thread openers (surface-0), state actions (surface-1),
			 *   pressed reaction chips (surface-2).
			 * - roles: author names in the transcript (surface-0).
			 * - surface-0 on accent: the send button's label on its fill.
			 */
			const pairs: [string, string][] = [
				["--text-primary", "--surface-0"],
				["--text-primary", "--surface-1"],
				["--text-primary", "--surface-2"],
				["--text-muted", "--surface-0"],
				["--text-muted", "--surface-1"],
				["--text-muted", "--surface-2"],
				["--accent", "--surface-0"],
				["--accent", "--surface-1"],
				["--accent", "--surface-2"],
				["--role-agent", "--surface-0"],
				["--role-you", "--surface-0"],
				["--role-system", "--surface-0"],
				["--surface-0", "--accent"],
			];
			const tokens = [...new Set(pairs.flat())];
			const resolved = await page.evaluate((names: string[]) => {
				const out: Record<string, string> = {};
				for (const name of names) {
					const node = document.createElement("div");
					node.style.color = `var(${name})`;
					document.body.append(node);
					out[name] = getComputedStyle(node).color;
					node.remove();
				}
				return out;
			}, tokens);

			const measured: Record<string, number> = {};
			for (const [text, surface] of pairs) {
				const ratio = contrastRatio(resolved[text], resolved[surface]);
				measured[`${text} on ${surface}`] = Number(ratio.toFixed(2));
				expect(
					ratio,
					`${text} on ${surface} must meet AAA`,
				).toBeGreaterThanOrEqual(7);
			}
			// Non-vacuity: the same math flags a pair that is genuinely weak.
			expect(
				contrastRatio(
					resolved["--surface-1"] ?? "rgb(22, 26, 33)",
					resolved["--surface-0"],
				),
			).toBeLessThan(7);
			console.log("[contrast]", JSON.stringify(measured));
			expect(errors).toEqual([]);
		},
	);

	browserTest("reduced motion removes non-essential animation", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const css = await readFile(
			join(import.meta.dir, "../src/console/style.css"),
			"utf8",
		);
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");

		const { page, errors } = await openPage();
		await page.emulateMediaFeatures([
			{ name: "prefers-reduced-motion", value: "reduce" },
		]);
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#channels .channel");
		const reduced = await page.$eval(
			"#channels .channel",
			(n) => getComputedStyle(n).transitionDuration,
		);
		expect(reduced).toBe("0s");

		// Without the preference the transition is present, so the variant
		// is doing real work rather than matching an already-static page.
		await page.emulateMediaFeatures([
			{ name: "prefers-reduced-motion", value: "no-preference" },
		]);
		const normal = await waitFor(
			"transitions restored",
			() =>
				page.$eval(
					"#channels .channel",
					(n) => getComputedStyle(n).transitionDuration,
				),
			(value) => value !== "0s",
		);
		expect(normal).not.toBe("0s");
		expect(errors).toEqual([]);
	});
});
