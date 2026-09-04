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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import {
	type ConsoleApi,
	type ConsoleEvent,
	startConsoleApi,
} from "../src/daemon/console-api";
import { createOperations } from "../src/daemon/operations";
import type { PeerStoreRoots } from "../src/daemon/peer-store";
import { createPeerStore } from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
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

function unexpectedPageErrors(errors: string[]): string[] {
	return errors.filter(
		(error) =>
			error !==
			"Failed to load resource: the server responded with a status of 401 (Unauthorized)",
	);
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
 * Focus a selector atomically in one in-page round-trip.
 *
 * `page.focus()` is two CDP round-trips — a selector resolution, then a
 * `focus()` on the handle it returned — and the transcript repaints on every
 * feed event. A repaint landing between the two detaches the resolved node,
 * and `focus()` on a detached node is a silent no-op, so the test proceeds
 * with focus still on `<body>`. Resolving and focusing inside one
 * `page.evaluate` makes the pair atomic with respect to the repaint: the
 * node cannot be replaced between the query and the call, because both run
 * in the same task as the page's own script.
 *
 * The other half of the same problem is environmental and is fixed in
 * `openPage` by `page.bringToFront()`: an unfocused document ignores
 * `HTMLElement.focus()` outright, whatever the timing.
 */
async function focusInPage(page: Page, selector: string): Promise<void> {
	await page.waitForSelector(selector, { timeout: 10_000 });
	await page.evaluate((s) => {
		const el = document.querySelector(s);
		if (el === null) throw new Error(`Not focusable: ${s}`);
		(el as unknown as { focus(): void }).focus();
	}, selector);
}

type AgentTab = "Members" | "Operations" | "Accounts";

/** Open the agent sheet through its visible trigger and select a visible tab. */
async function openAgentTab(
	page: Page,
	tab: AgentTab = "Members",
): Promise<void> {
	await page.click("#open-agents");
	await page.waitForSelector('[data-slot="sheet-content"]', { visible: true });
	const triggers = await page.$$('[data-slot="sheet-content"] [role="tab"]');
	const labels = await Promise.all(
		triggers.map((trigger) =>
			trigger.evaluate((node) => (node.textContent ?? "").trim()),
		),
	);
	const index = labels.indexOf(tab);
	if (index < 0 || triggers[index] === undefined) {
		throw new Error(`Missing visible agent tab: ${tab}`);
	}
	await triggers[index].click();
	await page.waitForSelector(
		tab === "Members"
			? "#agents"
			: tab === "Operations"
				? "#ops"
				: "#ops-accounts",
		{ visible: true },
	);
}

/** A nested agent dialog replaces the sheet; closing it restores the sheet. */
async function waitForAgentSheet(page: Page, visible: boolean): Promise<void> {
	await page.waitForSelector('[data-slot="sheet-content"]', {
		visible,
		hidden: !visible,
	});
}

/** Transcript bodies rendered in the channel pane. */
const renderedMessages = (page: Page): Promise<string[]> =>
	page.$$eval("#messages .message .body", (nodes) =>
		nodes.map((n) => (n.textContent ?? "").trim()),
	);

/** Mention affordances rendered for one message: agent names include `@`. */
const renderedMentions = (page: Page, messageId: number): Promise<string[]> =>
	page.$$eval(`#messages .message[data-id="${messageId}"] .mention`, (nodes) =>
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
const OPERATOR_TOKEN_KEY = "oh-my-agent.operator-token";

function stubWorker(name = "reviewer", fingerprint?: string) {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";
	/**
	 * The stderr the logs tail reads. Without a source here the logs test
	 * asserts an empty tail against an empty worker and passes whether or not
	 * the route works at all.
	 */
	const stderr: string[] = [];

	const worker: PeerRecord["worker"] = {
		name,
		fingerprint,
		get state() {
			return state;
		},
		stderr: () => stderr.join("\n"),
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

	return { worker, prompts, stderr };
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
async function harness(
	options: { pollIntervalMs?: number; remoteMode?: boolean } = {},
) {
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

	/**
	 * Where the supervisor's transitions go. The daemon builds the supervisor
	 * before the console exists, so it forwards through a mutable reference
	 * the handle names once `startConsoleApi` has returned.
	 */
	let sink: ((event: ConsoleEvent) => void) | undefined;

	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => Date.now(),
		peers: peerStore,
		respawn: async ({ peerName, definition }) =>
			stubWorker(peerName, fingerprintPeerDefinition(definition)).worker,
		emit: (event) => sink?.(event),
	});

	const peers = new Map<string, PeerRecord>();
	const knownRooms = new Map<string, RoomInfo>();
	const ensureRoom = async (id: string): Promise<void> => {
		if (knownRooms.has(id)) return;
		const kind = id.startsWith("@") ? "dm" : "channel";
		await rooms.createRoom({ id, kind });
		knownRooms.set(id, { id, kind, name: id });
	};

	/**
	 * The same ops seam `./main` composes, so the browser drives the real
	 * kill/inject/logs/bump rather than a console-local imitation. Without it
	 * every ops route 500s and the panel tests fail for the wrong reason.
	 */
	const operations = createOperations({
		rooms,
		supervisor,
		peers,
		killPeer: async (name, killOptions) => {
			// The daemon's cascade, in miniature: the named peer plus its whole
			// subtree — transitively, as `main.ts`'s `descendantsOf` walks it —
			// deepest first, unless the caller asked to keep the children. A
			// direct-children-only stub would pass a grandchild assertion that
			// production would fail.
			const doomed = [name];
			if (!killOptions.keepChildren) {
				for (let cursor = 0; cursor < doomed.length; cursor += 1) {
					const current = doomed[cursor];
					for (const [child, record] of peers) {
						if (record.parent !== current || doomed.includes(child)) continue;
						doomed.push(child);
					}
				}
			}
			for (const peerName of doomed.reverse()) {
				await peers.get(peerName)?.worker.stop();
			}
		},
		bumpAccount: async (accountId, budgetUsd) => {
			// Parked-before, as `main.ts` computes it: "resumed" names peers
			// the bump restarted, not every peer on the account.
			const parkedBefore = [...peers]
				.filter(
					([, record]) =>
						record.accountId === accountId && record.worker.state === "parked",
				)
				.map(([name]) => name);
			supervisor.bumpBudget(accountId, budgetUsd);
			await supervisor.settled();
			return parkedBefore.filter(
				(name) => peers.get(name)?.worker.state === "running",
			);
		},
	});

	const api: ConsoleApi = await startConsoleApi({
		rooms,
		supervisor,
		peers,
		peerStore,
		knownRooms,
		ensureRoom,
		operations,
		token: TOKEN,
		pollIntervalMs: options.pollIntervalMs ?? 25,
		...(options.remoteMode
			? { remoteMode: true, proxySecret: "console-client-proxy-secret" }
			: {}),
	});
	// The supervisor's transitions go through the swappable sink, which
	// defaults to the socket broadcast; route emissions use `publish`.
	sink = api.emit;

	const registerPeer = async (
		name: string,
		roomIds: string[],
		peerOptions: {
			parent?: string;
			accountId?: string;
			mode?: "subscription" | "metered";
			budgetUsd?: number;
		} = {},
	): Promise<{
		prompts: string[];
		stderr: string[];
		state: () => string;
	}> => {
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
		const accountId = peerOptions.accountId ?? "acct-1";
		for (const room of roomIds) await ensureRoom(room);
		await supervisor.register({
			worker: stub.worker,
			accountId,
			mode: peerOptions.mode ?? "subscription",
			rooms: roomIds,
			...(peerOptions.budgetUsd === undefined
				? {}
				: { budgetUsd: peerOptions.budgetUsd }),
		});
		peers.set(name, {
			worker: stub.worker,
			accountId,
			rooms: roomIds,
			...(peerOptions.parent === undefined
				? {}
				: { parent: peerOptions.parent }),
		});
		return {
			prompts: stub.prompts,
			stderr: stub.stderr,
			state: () => stub.worker.state,
		};
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
	/**
	 * Feed and fault control for the proxy, so a test can be deaf on purpose.
	 *
	 * `dropMessages` severs exactly one path — the live `message` frame — while
	 * leaving the store, the API, and the socket lifecycle real. Anything the
	 * page then paints about activity it did not see is a fetch's doing, which
	 * is what makes reconciliation provable rather than merely observed
	 * alongside a live update. `faultyRooms` fails one room's reconcile read
	 * — identified by the client's `X-Reconcile` marker, not by a query
	 * string a later caller could collide with — and no other's, and
	 * `reconcileReads` counts those reads so a test can prove a later socket
	 * open retried rather than merely stopped complaining.
	 *
	 * `holdConnect` withholds the handshake itself. Closing a socket starts a
	 * backoff the test does not control, so a reconnect can open — and
	 * reconcile — before the writes it is supposed to discover have landed.
	 * Holding the next upgrade makes close → write → reconnect an order rather
	 * than a hope.
	 */
	const feed = {
		dropMessages: false,
		/** Message frames withheld from the page. */
		dropped: [] as string[],
		/** Rooms whose reconcile read (marked `X-Reconcile`) answers 502. */
		faultyRooms: new Set<string>(),
		/** Marked reconcile reads served per room, faulty or not. */
		reconcileReads: new Map<string, number>(),
		/** While set, /api/events handshakes wait on this. */
		holdConnect: null as Promise<void> | null,
		/** Handshakes attempted, held or not. */
		connects: 0,
		/** Refuse WebSocket tickets after a test has observed initial success. */
		refuseWsTickets: false,
		/** Force message POSTs to expire for auth-race coverage. */
		unauthorizedApi: false,
		/** Hold concurrent session refusals until a test releases each response. */
		holdSessionRefusals: false,
		sessionRefusalReleases: [] as Array<() => void>,
		sendRaw: (data: string) => {
			let recipients = 0;
			for (const [upstream, socket] of downstreamByUpstream) {
				if (upstream.readyState !== WebSocket.OPEN) continue;
				socket.send(data);
				recipients += 1;
			}
			return recipients;
		},
	};
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
				feed.connects += 1;
				// Awaited before the upstream socket is even created, so a held
				// reconnect does no work at all until the test releases it.
				if (feed.holdConnect !== null) await feed.holdConnect;
				const upstreamUrl = new URL(api.url + url.pathname + url.search);
				upstreamUrl.protocol =
					upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
				const upstream = new WebSocket(upstreamUrl.href, {
					...(options.remoteMode
						? {
								headers: {
									"X-OMA-Proxy-Secret": "console-client-proxy-secret",
									"X-Forwarded-Host": "remote.example",
									"X-Forwarded-Proto": "https",
								},
							}
						: {}),
				});
				pendingFrames.set(upstream, []);
				upstream.addEventListener("message", (event) => {
					const data = String(event.data);
					// Parsed, not substring-matched: `"type":"message"` also
					// appears inside a quoted body, so a message about a message
					// frame would drop a frame this test meant to deliver.
					let type: unknown;
					try {
						const frame: unknown = JSON.parse(data);
						type =
							frame !== null && typeof frame === "object" && "type" in frame
								? frame.type
								: undefined;
					} catch {
						type = undefined;
					}
					if (feed.dropMessages && type === "message") {
						feed.dropped.push(data);
						return;
					}
					const socket = downstreamByUpstream.get(upstream);
					if (socket === undefined) {
						pendingFrames.get(upstream)?.push(data);
						return;
					}
					socket.send(data);
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
				if (
					request.method === "POST" &&
					url.pathname === "/api/session" &&
					feed.holdSessionRefusals
				) {
					const held = Promise.withResolvers<void>();
					feed.sessionRefusalReleases.push(held.resolve);
					await held.promise;
					return Response.json(
						{
							error: {
								code: "unauthorized",
								message: "Operator token refused",
							},
						},
						{ status: 401 },
					);
				}
				if (
					request.method === "POST" &&
					/^\/api\/channels\/[^/]+\/messages$/.test(url.pathname) &&
					feed.unauthorizedApi
				) {
					return Response.json(
						{
							error: {
								code: "unauthorized",
								message: "Operator token refused",
							},
						},
						{ status: 401 },
					);
				}
				if (url.pathname === "/api/ws-ticket" && feed.refuseWsTickets) {
					return Response.json(
						{
							error: {
								code: "unauthorized",
								message: "Operator token refused",
							},
						},
						{ status: 401 },
					);
				}
				const messagesRoute = /^\/api\/channels\/([^/]+)\/messages$/.exec(
					url.pathname,
				);
				// Scoped by the marker the client sends on reconcile reads
				// alone, so a room can be unreadable to reconciliation while
				// its transcript still loads — otherwise the fault would also
				// break selecting the room and the test would prove the wrong
				// thing. A marker rather than `?limit=`: an unrelated future
				// paged read must not be silently faulted.
				if (
					request.method === "GET" &&
					messagesRoute?.[1] !== undefined &&
					request.headers.get("X-Reconcile") !== null
				) {
					const roomId = decodeURIComponent(messagesRoute[1]);
					feed.reconcileReads.set(
						roomId,
						(feed.reconcileReads.get(roomId) ?? 0) + 1,
					);
					if (feed.faultyRooms.has(roomId)) {
						return new Response(
							JSON.stringify({
								error: { code: "unavailable", message: "room unreadable" },
							}),
							{ status: 502, headers: { "content-type": "application/json" } },
						);
					}
				}
				const headers = new Headers(request.headers);
				const presented = request.headers.get("X-Operator-Token");
				if (presented !== null) {
					headers.set("Authorization", `Bearer ${presented}`);
					headers.delete("X-Operator-Token");
				}
				if (options.remoteMode) {
					headers.set("X-OMA-Proxy-Secret", "console-client-proxy-secret");
					headers.set("X-Forwarded-Host", "remote.example");
					headers.set("X-Forwarded-Proto", "https");
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
			if (options.remoteMode) {
				const headers = new Headers(request.headers);
				headers.set("X-OMA-Proxy-Secret", "console-client-proxy-secret");
				headers.set("X-Forwarded-Host", "remote.example");
				headers.set("X-Forwarded-Proto", "https");
				return fetch(
					new Request(api.url + url.pathname + url.search, {
						method: request.method,
						headers,
					}),
				);
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
	const remoteConsoleUrl = `http://127.0.0.1:${web.port}/`;

	return {
		rooms,
		supervisor,
		registerPeer,
		ensureRoom,
		reload,
		promptsContaining,
		consoleUrl,
		remoteConsoleUrl,
		/** Proxy-level feed and fault control; see its declaration above. */
		feed,
		/** The console API itself, for writes made behind the browser's back. */
		apiUrl: api.url,
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

	browserTest("message mentions render as distinct affordances", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Please review this, @agent.",
		});

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });

		await waitFor(
			"mention affordance",
			() => renderedMentions(page, posted.id),
			(mentions) => mentions.includes("@agent"),
		);
		expect(await renderedMentions(page, posted.id)).toEqual(["@agent"]);
		expect(errors).toEqual([]);
	});
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

	browserTest(
		"an out-of-band unreact clears the chip with no reload",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const posted = await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Watch this chip.",
			});
			await h.rooms.react(posted.id, "reviewer", "👀");
			await h.rooms.react(posted.id, "second-agent", "👀");
			await h.rooms.react(posted.id, "third-agent", "✅");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"both chips",
				() => renderedReactions(page, posted.id),
				(chips) => chips.includes("👀 2") && chips.includes("✅ 1"),
			);

			// Stamp the document so a reload is observable rather than assumed:
			// a navigation resets the title, an in-place mutation cannot.
			await page.evaluate(() => {
				(document as unknown as { title: string }).title = "no-reload";
			});

			// One of two actors drops theirs: the chip stays, the count falls.
			await h.rooms.unreact(posted.id, "reviewer", "👀");
			await waitFor(
				"count falls to one",
				() => renderedReactions(page, posted.id),
				(chips) => chips.includes("👀 1"),
			);

			// The last actor drops theirs: the chip goes away entirely, and
			// the unrelated ✅ is untouched.
			await h.rooms.unreact(posted.id, "second-agent", "👀");
			const remaining = await waitFor(
				"the eye chip removed",
				() => renderedReactions(page, posted.id),
				(chips) => !chips.some((chip) => chip.startsWith("👀")),
			);
			expect(remaining).toEqual(["✅ 1"]);

			expect(
				await page.evaluate(
					() => (document as unknown as { title: string }).title,
				),
			).toBe("no-reload");
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"an out-of-band reaction by the operator marks the chip as theirs",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const posted = await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Pressed state follows the frame.",
			});
			await h.rooms.react(posted.id, "reviewer", "👀");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			const chip = `#messages .message[data-id="${posted.id}"] .reaction`;
			await waitFor(
				"the chip, unpressed",
				() =>
					page
						.$eval(chip, (n) => n.getAttribute("aria-pressed") ?? "")
						.catch(() => null),
				(pressed) => pressed === "false",
			);

			// The human reacting from somewhere else — a second console, the
			// TUI — must flip this console's pressed state, because the chip
			// is a toggle and a wrong pressed state inverts the next Enter.
			await h.rooms.react(posted.id, "@you", "👀");
			const pressed = await waitFor(
				"the chip, pressed",
				() =>
					page
						.$eval(chip, (n) => ({
							pressed: n.getAttribute("aria-pressed") ?? "",
							mine: n.className.includes("mine"),
							text: (n.textContent ?? "").trim(),
						}))
						.catch(() => null),
				(state) => state !== null && state.pressed === "true",
			);
			expect(pressed?.mine).toBe(true);
			expect(pressed?.text).toBe("👀 2");
			expect(errors).toEqual([]);
		},
	);
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
		await page.click("#open-new-channel");
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
			await page.click("#open-new-agent");
			await page.waitForSelector("#new-agent-name");

			await page.type("#new-agent-name", "researcher");
			await page.type("#new-agent-description", "Researches things.");
			await page.type("#new-agent-spawns", "scout");
			await page.type("#new-agent-rooms", "#reviews");
			await page.type("#new-agent-body", "You are the researcher.");
			await page.click("#new-agent-create");
			await page.waitForSelector("#new-agent-name", { hidden: true });
			await openAgentTab(page);

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
			await page.click("#open-new-agent");
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

// ── Definition editing (T-1607) ──────────────────────────────────────────────

describe("definition editor", () => {
	browserTest(
		"an agent's definition opens, edits, and saves from the console",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.registerPeer("reviewer", ["#reviews"]);

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await openAgentTab(page);
			await page.waitForSelector('.definition-edit[data-name="reviewer"]');

			// Open the editor from the agent's own row.
			await page.click('.definition-edit[data-name="reviewer"]');
			await waitForAgentSheet(page, false);

			// The editor is loaded from the server, not invented in the page:
			// the fields the daemon holds are what appears.
			const loaded = await waitFor(
				"definition loaded into the editor",
				() =>
					page
						.$eval(
							"#definition-changes",
							(node) => (node as unknown as { value: string }).value,
						)
						.catch(() => ""),
				(text) => text.includes("reviewer peer for console client tests."),
			);
			expect(loaded).toContain("description");

			// Edit one field and save.
			await page.$eval("#definition-changes", (node) => {
				(node as unknown as { value: string }).value = JSON.stringify(
					{ description: "Edited from the console." },
					null,
					2,
				);
			});
			await page.click("#definition-save");
			await waitForAgentSheet(page, true);

			// The durable proof: a cold peer store reads the edit back.
			await waitFor(
				"definition rewritten on disk",
				async () =>
					(await h.reload()).definitions.find((d) => d.name === "reviewer")
						?.description ?? "",
				(description) => description === "Edited from the console.",
			);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"an unknown key is refused inline and nothing is written",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.registerPeer("reviewer", ["#reviews"]);
			const before =
				(await h.reload()).definitions.find((d) => d.name === "reviewer")
					?.description ?? "";

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await openAgentTab(page);
			await page.waitForSelector('.definition-edit[data-name="reviewer"]');
			await page.click('.definition-edit[data-name="reviewer"]');
			await waitForAgentSheet(page, false);
			await page.waitForSelector("#definition-changes");

			// A top-level key the strict parser does not know. This is the
			// case the render path silently drops, so a console that reported
			// success here would tell the operator an edit landed that never
			// existed on disk.
			await page.$eval("#definition-changes", (node) => {
				(node as unknown as { value: string }).value = '{ "nonsense": true }';
			});
			await page.click("#definition-save");

			const shown = await waitFor(
				"strict parser error rendered inline",
				() =>
					page
						.$eval("#definition-error", (node) => node.textContent ?? "")
						.catch(() => ""),
				(text) => text.includes("nonsense"),
			);
			expect(shown).toContain("nonsense");

			// Refused, not partially applied: the definition on disk is intact.
			expect(
				(await h.reload()).definitions.find((d) => d.name === "reviewer")
					?.description,
			).toBe(before);
			expect(
				errors.filter((entry) => !entry.startsWith("Failed to load resource")),
			).toEqual([]);
		},
	);

	browserTest("the definition editor is keyboard-operable", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.registerPeer("reviewer", ["#reviews"]);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page);
		await page.waitForSelector('.definition-edit[data-name="reviewer"]');

		// Opened by keyboard, and focus follows into the editor rather than
		// being left behind on a control the panel now covers.
		await focusInPage(page, '.definition-edit[data-name="reviewer"]');
		await page.keyboard.press("Enter");
		await waitForAgentSheet(page, false);
		const inside = await waitFor(
			"focus inside the editor",
			() => focusProbe(page),
			(probe) => (probe?.id ?? "") === "definition-changes",
		);
		expect(inside?.id).toBe("definition-changes");

		// The editor is a labelled dialog, so a screen-reader user is told
		// which agent they are editing rather than "dialog".
		const dialog = await page.$eval("#definition-dialog", (node) => ({
			label: node.getAttribute("aria-label") ?? "",
			labelledBy: node.getAttribute("aria-labelledby") ?? "",
		}));
		expect(dialog.label.length + dialog.labelledBy.length).toBeGreaterThan(0);
		expect(
			await page.$eval(
				"#definition-changes",
				(node) => node.getAttribute("aria-label") ?? "",
			),
		).not.toBe("");

		// Escape closes it and hands the keyboard back to the opener (T-1615).
		await page.keyboard.press("Escape");
		await waitForAgentSheet(page, true);
		const returned = await waitFor(
			"focus back on the opener",
			() => focusProbe(page),
			(probe) => (probe?.className ?? "").includes("definition-edit"),
		);
		expect(returned?.className).toContain("definition-edit");
		expect(errors).toEqual([]);
	});
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
			await openAgentTab(page);
			await page.waitForSelector(
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			await page.click(
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
			await openAgentTab(page);
			await page.waitForSelector(
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			await page.click(
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
			await openAgentTab(page);
			await page.waitForSelector(
				'#agents .agent[data-name="reviewer"] .membership-toggle',
			);

			await page.click(
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

	browserTest(
		"a route-driven agent change updates the agents panel with no reload",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			await h.registerPeer("reviewer", ["#reviews"]);

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await openAgentTab(page);
			await waitFor(
				"the agents panel",
				() =>
					page.$$eval("#agents .agent", (nodes) =>
						nodes.map((n) => (n.textContent ?? "").trim()),
					),
				(list) => list.some((entry) => entry.includes("reviewer")),
			);
			// The open room is #reviews, so the toggle reads "Leave" there.
			expect(
				await page.$eval(
					'#agents .agent[data-name="reviewer"] .membership-toggle',
					(n) => n.getAttribute("data-member") ?? "",
				),
			).toBe("true");

			await page.evaluate(() => {
				(document as unknown as { title: string }).title = "no-reload";
			});

			// Membership changed behind the console's back — a second console,
			// the TUI, the daemon itself. The panel must follow without the
			// operator reloading, and without the transcript being rebuilt.
			const removed = await fetch(
				`${h.apiUrl}/api/agents/reviewer/rooms/${encodeURIComponent("#reviews")}`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${TOKEN}` },
				},
			);
			expect(removed.status).toBe(200);

			await waitFor(
				"the membership toggle to follow",
				() =>
					page
						.$eval(
							'#agents .agent[data-name="reviewer"] .membership-toggle',
							(n) => n.getAttribute("data-member") ?? "",
						)
						.catch(() => null),
				(member) => member === "false",
			);
			expect(
				await page.evaluate(
					() => (document as unknown as { title: string }).title,
				),
			).toBe("no-reload");
			expect(errors).toEqual([]);
		},
	);
});

// ── Operations panel (T-1605) ────────────────────────────────────────────────

/**
 * Kill, inject, logs tail, and budget bump, driven from the browser.
 *
 * Every one of these runs keyboard-only — Tab to reach the control, Enter to
 * activate it — because an operator surface that needs a pointer is one an
 * operator on a screen reader cannot use at all. Kill additionally requires
 * an explicit confirmation that *names the children it will take*: the
 * default is the cascade, so an operator who misreads the dialog loses a
 * subtree, and there is no undo.
 */
describe("operations panel", () => {
	browserTest(
		"kill requires subtree confirmation and stops the worker",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const boss = await h.registerPeer("boss", ["#reviews"]);
			const report = await h.registerPeer("report", ["#reviews"], {
				parent: "boss",
			});
			// A grandchild: the daemon's cascade walks to the leaves, so a
			// confirmation naming only the direct children would let an
			// operator approve killing an agent it never mentioned.
			const intern = await h.registerPeer("intern", ["#reviews"], {
				parent: "report",
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await openAgentTab(page, "Operations");
			await page.waitForSelector('#ops .ops-agent[data-name="boss"]');

			// Reach the kill control by keyboard and open the confirmation.
			await focusInPage(page, '#ops .ops-agent[data-name="boss"] .ops-kill');
			await page.keyboard.press("Enter");
			await page.waitForSelector("#ops-kill-dialog[open]");
			await waitForAgentSheet(page, false);

			// The dialog names the whole subtree the cascade will take, and
			// defaults to cascading, because that is what the daemon does.
			const dialogText = await page.$eval(
				"#ops-kill-dialog",
				(node) => node.textContent ?? "",
			);
			expect(dialogText).toContain("boss");
			expect(dialogText).toContain("report");
			expect(dialogText).toContain("intern");
			expect(
				await page.$eval("#ops-kill-keep", (node) =>
					node.getAttribute("aria-checked"),
				),
			).toBe("false");

			// Focus moved into the dialog when it opened (T-1615's helpers).
			const inDialog = await waitFor(
				"focus inside the kill dialog",
				() =>
					page.evaluate(
						() => document.activeElement?.closest("#ops-kill-dialog") !== null,
					),
				(inside) => inside === true,
			);
			expect(inDialog).toBe(true);

			// Confirm by keyboard.
			await focusInPage(page, "#ops-kill-confirm");
			await page.keyboard.press("Enter");

			await waitFor(
				"the worker to stop",
				() => Promise.resolve(boss.state()),
				(state) => state === "stopped",
			);
			// The cascade is real, and transitive: the grandchild went too.
			await waitForAgentSheet(page, true);
			expect(report.state()).toBe("stopped");
			expect(intern.state()).toBe("stopped");
			await page.waitForSelector("#ops-kill-dialog:not([open])");
			expect(errors).toEqual([]);
		},
	);

	browserTest("dismissing the kill confirmation kills nothing", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const boss = await h.registerPeer("boss", ["#reviews"]);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page, "Operations");
		await page.waitForSelector('#ops .ops-agent[data-name="boss"]');

		await focusInPage(page, '#ops .ops-agent[data-name="boss"] .ops-kill');
		await page.keyboard.press("Enter");
		await page.waitForSelector("#ops-kill-dialog[open]");
		await waitForAgentSheet(page, false);

		// Escape is the standard dismissal for a <dialog>, and dismissing a
		// destructive confirmation must be inert, not "the default happened".
		await page.keyboard.press("Escape");
		await page.waitForSelector("#ops-kill-dialog:not([open])");
		await waitForAgentSheet(page, true);
		expect(boss.state()).toBe("running");

		// Focus came back to the control that opened it.
		const returned = await waitFor(
			"focus returned to the kill opener",
			() => focusProbe(page),
			(probe) => (probe?.className ?? "").includes("ops-kill"),
		);
		expect(returned?.className).toContain("ops-kill");
		expect(errors).toEqual([]);
	});

	browserTest("keeping children spares the subtree", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const boss = await h.registerPeer("boss", ["#reviews"]);
		const report = await h.registerPeer("report", ["#reviews"], {
			parent: "boss",
		});

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page, "Operations");
		await page.waitForSelector('#ops .ops-agent[data-name="boss"]');

		await focusInPage(page, '#ops .ops-agent[data-name="boss"] .ops-kill');
		await page.keyboard.press("Enter");
		await waitForAgentSheet(page, false);
		await page.waitForSelector("#ops-kill-dialog[open]");

		// Opt out of the cascade by keyboard: Space toggles a checkbox.
		await focusInPage(page, "#ops-kill-keep");
		await page.keyboard.press("Space");
		expect(
			await page.$eval("#ops-kill-keep", (node) =>
				node.getAttribute("aria-checked"),
			),
		).toBe("true");
		await focusInPage(page, "#ops-kill-confirm");
		await page.keyboard.press("Enter");

		await waitFor(
			"the parent to stop",
			() => Promise.resolve(boss.state()),
			(state) => state === "stopped",
		);
		await waitForAgentSheet(page, true);
		expect(report.state()).toBe("running");
		expect(errors).toEqual([]);
	});

	browserTest("inject reaches the worker by keyboard alone", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page, "Operations");
		await page.waitForSelector('#ops .ops-agent[data-name="reviewer"]');

		await focusInPage(
			page,
			'#ops .ops-agent[data-name="reviewer"] .ops-inject-input',
		);
		await page.keyboard.type("Check the failing build.");
		await page.keyboard.press("Enter");

		const prompts = await h.promptsContaining(
			peer.prompts,
			"Check the failing build.",
		);
		expect(prompts).toContain("Check the failing build.");
		expect(errors).toEqual([]);
	});

	browserTest("the logs tail renders the worker's stderr", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		peer.stderr.push(
			"boot: materialized",
			"turn 1: prompted",
			"turn 1: answered",
		);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page, "Operations");
		await page.waitForSelector('#ops .ops-agent[data-name="reviewer"]');

		await focusInPage(page, '#ops .ops-agent[data-name="reviewer"] .ops-logs');
		await page.keyboard.press("Enter");

		const tail = await waitFor(
			"the logs tail",
			() =>
				page
					.$eval("#ops-logs-output", (node) => node.textContent ?? "")
					.catch(() => ""),
			(text) => text.includes("turn 1: answered"),
		);
		// Newest last, and the whole tail — not one line, not reversed.
		expect(tail).toContain("boot: materialized");
		expect(tail.indexOf("boot: materialized")).toBeLessThan(
			tail.indexOf("turn 1: answered"),
		);
		expect(await page.$eval("#ops-logs-output", (n) => n.tagName)).toBe("PRE");
		expect(errors).toEqual([]);
	});

	browserTest("a bump renders the new ceiling", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.registerPeer("spender", ["#reviews"], {
			accountId: "acct-metered",
			mode: "metered",
			budgetUsd: 5,
		});

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page, "Accounts");
		await page.waitForSelector(
			'#ops-accounts .ops-account[data-account="acct-metered"]',
		);

		await focusInPage(
			page,
			'#ops-accounts .ops-account[data-account="acct-metered"] .ops-bump-input',
		);
		await page.keyboard.type("42");
		await page.keyboard.press("Enter");

		// The ceiling repaints from the budget frame (T-1604), not a poll.
		const ceiling = await waitFor(
			"the new ceiling",
			() =>
				page
					.$eval(
						'#ops-accounts .ops-account[data-account="acct-metered"] .ops-budget',
						(node) => node.textContent ?? "",
					)
					.catch(() => ""),
			(text) => text.includes("42"),
		);
		expect(ceiling).toContain("42");
		expect(errors).toEqual([]);
	});

	browserTest("the panel exposes accessible names and roles", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.registerPeer("reviewer", ["#reviews"]);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await openAgentTab(page, "Operations");
		await page.waitForSelector('#ops .ops-agent[data-name="reviewer"]');

		// The panel is a named region, so a screen reader can jump to it.
		const region = await page.$eval("#ops", (node) => ({
			tag: node.tagName,
			label: node.getAttribute("aria-label") ?? "",
		}));
		expect(region.label.length).toBeGreaterThan(0);

		// Every control carries a name, and the destructive one says so.
		for (const selector of [
			'#ops .ops-agent[data-name="reviewer"] .ops-kill',
			'#ops .ops-agent[data-name="reviewer"] .ops-logs',
			'#ops .ops-agent[data-name="reviewer"] .ops-inject-input',
		]) {
			const named = await page.$eval(selector, (node) => {
				const label = node.getAttribute("aria-label") ?? "";
				return label.length > 0 ? label : (node.textContent ?? "").trim();
			});
			expect(named.length).toBeGreaterThan(0);
		}

		// The logs output is a live region: it fills in after a round trip,
		// and a sighted operator sees that without being told.
		expect(
			await page.$eval("#ops-logs-output", (n) => n.getAttribute("aria-live")),
		).toBe("polite");

		// Open the real destructive control before asserting its dialog contract.
		await page.click('#ops .ops-agent[data-name="reviewer"] .ops-kill');
		await waitForAgentSheet(page, false);
		await page.waitForSelector("#ops-kill-dialog[open]", { visible: true });
		expect(await page.$eval("#ops-kill-dialog", (n) => n.tagName)).toBe(
			"DIALOG",
		);
		await page.click("#ops-kill-cancel");
		await page.waitForSelector("#ops-kill-dialog:not([open])");
		await waitForAgentSheet(page, true);
		expect(errors).toEqual([]);
	});
});

// ── Visual system (T-1101) ───────────────────────────────────────────────────

describe("visual system", () => {
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

async function operatorAuthState(page: Page) {
	return {
		visible: await page.$eval(
			"#operator-auth",
			(node) => !node.hasAttribute("hidden"),
		),
		appHidden: await page.evaluate(() => {
			const main = document.querySelector(
				"#main",
			) as unknown as A11yNode | null;
			return main === null || main.getAttribute("hidden") !== null;
		}),
		error: await page.$eval(
			"#operator-auth-error",
			(node) => node.textContent ?? "",
		),
		focused: await page.$eval(
			"#operator-token",
			(node) => node === document.activeElement,
		),
		value: await page.$eval("#operator-token", (node) =>
			"value" in node ? String(node.value) : "",
		),
		stored: await page.evaluate(
			(key) => sessionStorage.getItem(key),
			OPERATOR_TOKEN_KEY,
		),
	};
}

describe("remote operator authentication", () => {
	browserTest(
		"keyboard token entry refuses bad tokens, persists good tokens, and keeps them out of URLs",
		async () => {
			const h = await harness({ remoteMode: true });
			await h.ensureRoom("#reviews");
			const { page } = await openPage();
			const urls: string[] = [];
			page.on("request", (request) => urls.push(request.url()));

			await page.goto(h.remoteConsoleUrl, { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#operator-token");
			expect(
				await page.$eval("label[for=operator-token]", (node) =>
					node.getAttribute("for"),
				),
			).toBe("operator-token");
			expect(
				await page.$eval(
					"#operator-token",
					(node) => node === document.activeElement,
				),
			).toBe(true);

			await page.keyboard.type("wrong-token");
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth-error:not(:empty)");
			expect(
				await page.$eval("#operator-auth-error", (node) =>
					node.getAttribute("role"),
				),
			).toBe("alert");
			expect(
				await page.$eval(
					"#operator-token",
					(node) => node === document.activeElement,
				),
			).toBe(true);

			await page.keyboard.type(TOKEN);
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth[hidden]");
			await waitFor(
				"root ticket removal",
				() => Promise.resolve(page.url()),
				(url) => !url.includes("ticket="),
			);
			expect(page.url()).not.toContain(TOKEN);
			expect(urls.every((url) => !url.includes(TOKEN))).toBe(true);

			await page.reload({ waitUntil: "domcontentloaded" });
			await page.waitForSelector("#operator-auth[hidden]");
			await waitFor(
				"reload ticket removal",
				() => Promise.resolve(page.url()),
				(url) => !url.includes("ticket="),
			);
			expect(page.url()).not.toContain("token=");
		},
	);

	browserTest(
		"a stale stored token returns a reloaded console to token entry",
		async () => {
			const h = await harness({ remoteMode: true });
			const { page, errors } = await openPage();

			const response = await page.goto(h.remoteConsoleUrl, {
				waitUntil: "domcontentloaded",
			});
			expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
			await page.evaluate(
				(key) => sessionStorage.setItem(key, "stale-token"),
				OPERATOR_TOKEN_KEY,
			);
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.waitForSelector("#operator-auth-error:not(:empty)");

			expect(await operatorAuthState(page)).toEqual({
				visible: true,
				appHidden: true,
				error: "Operator token refused. Re-enter the token.",
				focused: true,
				value: "",
				stored: null,
			});
			expect(unexpectedPageErrors(errors)).toEqual([]);
		},
	);

	browserTest(
		"concurrent session refusals preserve active token re-entry",
		async () => {
			const h = await harness({ remoteMode: true });
			h.feed.holdSessionRefusals = true;
			const { page, errors } = await openPage();

			await page.goto(h.remoteConsoleUrl, { waitUntil: "domcontentloaded" });
			await page.type("#operator-token", "refused-token");
			await page.keyboard.press("Enter");
			await page.keyboard.press("Enter");
			await waitFor(
				"two concurrent session attempts",
				() => Promise.resolve(h.feed.sessionRefusalReleases.length),
				(count) => count === 2,
			);

			h.feed.sessionRefusalReleases.shift()?.();
			await page.waitForSelector("#operator-auth-error:not(:empty)");
			await page.type("#operator-token", "replacement-in-progress");
			await page.evaluate(
				(key) => sessionStorage.setItem(key, "must-clear"),
				OPERATOR_TOKEN_KEY,
			);

			h.feed.sessionRefusalReleases.shift()?.();
			await waitFor(
				"second refusal storage clear",
				() =>
					page.evaluate(
						(key) => sessionStorage.getItem(key),
						OPERATOR_TOKEN_KEY,
					),
				(stored) => stored === null,
			);

			expect(await operatorAuthState(page)).toMatchObject({
				visible: true,
				appHidden: true,
				error: "Operator token refused. Re-enter the token.",
				focused: true,
				value: "replacement-in-progress",
				stored: null,
			});
			expect(
				await page.evaluate(
					() => Reflect.get(globalThis, "__consoleSockets") === undefined,
				),
			).toBe(true);
			expect(unexpectedPageErrors(errors)).toEqual([]);
		},
	);

	browserTest(
		"a refused reconnect ticket returns the console to token entry",
		async () => {
			const h = await harness({ remoteMode: true });
			await h.ensureRoom("#reviews");
			const { page, errors } = await openPage();

			await page.goto(h.remoteConsoleUrl, { waitUntil: "domcontentloaded" });
			await page.type("#operator-token", TOKEN);
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth[hidden]");
			await waitFor(
				"initial remote socket",
				() =>
					page.evaluate(() => {
						const sockets = Reflect.get(globalThis, "__consoleSockets");
						return (
							Array.isArray(sockets) &&
							sockets.some(
								(socket) =>
									socket instanceof WebSocket &&
									socket.readyState === WebSocket.OPEN,
							)
						);
					}),
				Boolean,
			);

			h.feed.refuseWsTickets = true;
			await page.evaluate(() => {
				const sockets = Reflect.get(globalThis, "__consoleSockets");
				if (!Array.isArray(sockets)) return;
				for (const socket of sockets) {
					if (
						socket instanceof WebSocket &&
						socket.readyState === WebSocket.OPEN
					) {
						socket.close();
						break;
					}
				}
			});
			await page.waitForSelector("#operator-auth-error:not(:empty)", {
				timeout: 5_000,
			});

			expect(await operatorAuthState(page)).toEqual({
				visible: true,
				appHidden: true,
				error: "Operator token refused. Re-enter the token.",
				focused: true,
				value: "",
				stored: null,
			});
			expect(unexpectedPageErrors(errors)).toEqual([]);
		},
	);

	browserTest(
		"revocation drops queued socket work and blocks stale HTTP requests",
		async () => {
			const h = await harness({ remoteMode: true });
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			const { page, errors } = await openPage();
			const requests: string[] = [];
			page.on("request", (request) => {
				const url = new URL(request.url());
				if (url.pathname.startsWith("/api/")) requests.push(url.pathname);
			});

			await page.goto(h.remoteConsoleUrl, { waitUntil: "domcontentloaded" });
			await page.type("#operator-token", TOKEN);
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth[hidden]");
			await waitFor(
				"initial remote socket",
				() =>
					page.evaluate(() =>
						(
							(globalThis as { __consoleSockets?: WebSocket[] })
								.__consoleSockets ?? []
						).some((socket) => socket.readyState === WebSocket.OPEN),
					),
				Boolean,
			);

			await waitFor(
				"initial reconcile pass",
				() =>
					page.evaluate(
						() =>
							(globalThis as { __consoleReconcilePasses?: number })
								.__consoleReconcilePasses ?? 0,
					),
				(count) => count > 0,
			);
			const queuedFrame = JSON.stringify({
				type: "message",
				message: { room: "#ops" },
			});

			await page.evaluate(() => {
				const sockets = Reflect.get(globalThis, "__consoleSockets");
				if (!Array.isArray(sockets)) throw new Error("Missing console sockets");
				const socket = sockets.find(
					(candidate) => candidate.readyState === WebSocket.OPEN,
				);
				if (!(socket instanceof WebSocket))
					throw new Error("Missing open socket");
				const close = socket.close;
				Reflect.set(socket, "close", () => {});
				Reflect.set(globalThis, "__releaseRevokedSocket", () => {
					close.call(socket);
				});
			});
			h.feed.unauthorizedApi = true;
			await page.type("#composer-input", "expire this session");
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth-error:not(:empty)");
			const requestsAtRevocation = requests.length;
			const reconcilePasses = await page.evaluate(
				() =>
					(globalThis as { __consoleReconcilePasses?: number })
						.__consoleReconcilePasses ?? 0,
			);
			const rawRecipients = h.feed.sendRaw(queuedFrame);
			expect(rawRecipients).toBeGreaterThan(0);
			await page.evaluate(() => {
				const input = document.querySelector("#composer-input");
				const form = document.querySelector("#composer");
				if (input === null) throw new Error("Missing #composer-input");
				if (form === null) throw new Error("Missing #composer");
				Reflect.set(input, "value", "must not reuse revoked token");
				Reflect.get(form, "requestSubmit").call(form);
			});
			await page.evaluate(() => fetch("/favicon.ico").then(() => undefined));
			await page.evaluate(() => {
				const release = Reflect.get(globalThis, "__releaseRevokedSocket");
				if (typeof release !== "function") {
					throw new Error("Missing revoked socket release");
				}
				release();
			});
			await waitFor(
				"revoked sockets drained",
				() =>
					page.evaluate(() => {
						const sockets = Reflect.get(globalThis, "__consoleSockets");
						return Array.isArray(sockets) ? sockets.length : -1;
					}),
				(count) => count === 0,
			);

			expect(requests).toHaveLength(requestsAtRevocation);
			expect(
				await page.evaluate(
					() =>
						(globalThis as { __consoleReconcilePasses?: number })
							.__consoleReconcilePasses ?? 0,
				),
			).toBe(reconcilePasses);
			expect((await unreadLabels(page)).join(" ")).not.toContain("#ops");
			expect(await stateOnPage(page)).not.toMatchObject({
				kind: "load-failure",
			});
			expect(unexpectedPageErrors(errors)).toEqual([]);
		},
	);

	browserTest(
		"authentication expiry cancels a scheduled reconnect without wiping re-entry",
		async () => {
			const h = await harness({ remoteMode: true });
			await h.ensureRoom("#reviews");
			const { page, errors } = await openPage();
			const requests: Array<{
				method: string;
				path: string;
				token: string | undefined;
			}> = [];
			page.on("request", (request) => {
				const url = new URL(request.url());
				if (!url.pathname.startsWith("/api/")) return;
				requests.push({
					method: request.method(),
					path: url.pathname,
					token: request.headers()["x-operator-token"],
				});
			});

			await page.goto(h.remoteConsoleUrl, { waitUntil: "domcontentloaded" });
			await page.type("#operator-token", TOKEN);
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth[hidden]");
			await waitFor(
				"initial remote socket",
				() =>
					page.evaluate(() => {
						const sockets = Reflect.get(globalThis, "__consoleSockets");
						return (
							Array.isArray(sockets) &&
							sockets.some(
								(socket) =>
									socket instanceof WebSocket &&
									socket.readyState === WebSocket.OPEN,
							)
						);
					}),
				Boolean,
			);
			await page.evaluate(() => {
				const sockets = Reflect.get(globalThis, "__consoleSockets");
				if (!Array.isArray(sockets)) return;
				sockets
					.find(
						(socket) =>
							socket instanceof WebSocket &&
							socket.readyState === WebSocket.OPEN,
					)
					?.close();
			});
			await waitFor(
				"closed socket removed after reconnect was scheduled",
				() =>
					page.evaluate(() => {
						const sockets = Reflect.get(globalThis, "__consoleSockets");
						return Array.isArray(sockets) ? sockets.length : -1;
					}),
				(count) => count === 0,
			);

			h.feed.unauthorizedApi = true;
			await page.type("#composer-input", "expired session");
			await page.keyboard.press("Enter");
			await page.waitForSelector("#operator-auth-error:not(:empty)");
			await page.type("#operator-token", "replacement-in-progress");
			h.feed.refuseWsTickets = true;

			const wsTicketsBefore = requests.filter(
				(request) => request.path === "/api/ws-ticket",
			);
			const readsBefore = requests.filter(
				(request) => request.method === "GET",
			).length;
			const connectsBefore = h.feed.connects;
			const socketsBefore = await page.evaluate(() => {
				const sockets = Reflect.get(globalThis, "__consoleSockets");
				return Array.isArray(sockets) ? sockets.length : -1;
			});
			// Authentication has rendered before virtual time moves, so React is not
			// frozen. Advancing past reconnect backoff proves its timer was canceled.
			const cdp = await page.createCDPSession();
			const budgetExpired = new Promise<void>((resolve) => {
				cdp.once("Emulation.virtualTimeBudgetExpired", () => resolve());
			});
			await cdp.send("Emulation.setVirtualTimePolicy", {
				policy: "advance",
				budget: 1_000,
			});
			await budgetExpired;
			await page.evaluate(() => Promise.resolve());

			const wsTicketsAfter = requests.filter(
				(request) => request.path === "/api/ws-ticket",
			);
			expect(wsTicketsAfter).toEqual(wsTicketsBefore);
			expect(wsTicketsAfter.map((request) => request.token)).toEqual([TOKEN]);
			expect(h.feed.connects).toBe(connectsBefore);
			expect(
				await page.evaluate(() => {
					const sockets = Reflect.get(globalThis, "__consoleSockets");
					return Array.isArray(sockets) ? sockets.length : -1;
				}),
			).toBe(socketsBefore);
			expect(
				requests.filter((request) => request.method === "GET").length,
			).toBe(readsBefore);
			expect(await operatorAuthState(page)).toMatchObject({
				visible: true,
				appHidden: true,
				value: "replacement-in-progress",
				stored: null,
			});
			expect(unexpectedPageErrors(errors)).toEqual([]);
		},
	);

	browserTest("an unauthenticated remote websocket is refused", async () => {
		const h = await harness({ remoteMode: true });
		const socket = new WebSocket(
			`${h.apiUrl.replace("http://", "ws://")}/api/events`,
			{
				headers: {
					"X-OMA-Proxy-Secret": "console-client-proxy-secret",
					"X-Forwarded-Host": "remote.example",
					"X-Forwarded-Proto": "https",
				},
			},
		);
		const result = await Promise.race([
			new Promise<string>((resolve) =>
				socket.addEventListener("open", () => resolve("open")),
			),
			new Promise<string>((resolve) =>
				socket.addEventListener("error", () => resolve("refused")),
			),
		]);
		socket.close();
		expect(result).toBe("refused");
	});

	browserTest("loopback console opens without an operator prompt", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const { page, errors } = await openPage();

		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await page.waitForSelector('#channels [role="option"]');
		expect(
			await page.$eval("#operator-auth", (node) => node.hasAttribute("hidden")),
		).toBe(true);
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
	apiBehavior: (url: URL) => Response | Promise<Response> | undefined | "hang",
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
		"a late transcript response cannot repaint a newly selected room",
		async () => {
			const delayedOps = Promise.withResolvers<Response>();
			let channelReads = 0;
			let opsRequested = false;
			const reviewsMessage = {
				id: 1,
				room: "#reviews",
				author: "reviewer",
				body: "Reviews transcript.",
				createdAt: 1,
				mentions: [],
				parentId: null,
				threadRootId: null,
				replyCount: 0,
				reactions: [],
			};
			const opsMessage = {
				...reviewsMessage,
				id: 2,
				room: "#ops",
				body: "Late ops transcript.",
			};
			const server = await degradedServer((url) => {
				if (url.pathname === "/api/channels") {
					channelReads += 1;
					return new Response(
						JSON.stringify({
							channels: [
								{ id: "#reviews", kind: "channel" },
								{ id: "#ops", kind: "channel" },
							],
						}),
						{ headers: { "content-type": "application/json" } },
					);
				}
				if (url.pathname === "/api/agents") {
					return new Response(JSON.stringify({ agents: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				if (url.pathname === "/api/channels/%23ops/messages") {
					opsRequested = true;
					return delayedOps.promise;
				}
				if (url.pathname === "/api/channels/%23reviews/messages") {
					return new Response(JSON.stringify({ messages: [reviewsMessage] }), {
						headers: { "content-type": "application/json" },
					});
				}
				return undefined;
			});
			const { page } = await openPage();
			await page.goto(server.url, { waitUntil: "domcontentloaded" });
			await waitFor(
				"initial reviews transcript",
				() => transcriptText(page),
				(text) => text.includes("Reviews transcript."),
			);

			await clickInPage(page, '#channels .channel[data-id="#ops"]');
			await waitFor(
				"delayed ops request",
				() => Promise.resolve(opsRequested),
				(requested) => requested,
			);
			await clickInPage(page, '#channels .channel[data-id="#reviews"]');
			await waitFor(
				"reviews selected again",
				() =>
					page.$eval("#current-channel h1", (node) => node.textContent ?? ""),
				(label) => label === "#reviews",
			);
			await waitFor(
				"reviews transcript restored",
				() => transcriptText(page),
				(text) => text.includes("Reviews transcript."),
			);

			delayedOps.resolve(
				new Response(JSON.stringify({ messages: [opsMessage] }), {
					headers: { "content-type": "application/json" },
				}),
			);
			await waitFor(
				"late selection request settled",
				() => Promise.resolve(channelReads),
				(reads) => reads >= 3,
			);
			expect(await transcriptText(page)).toContain("Reviews transcript.");
			expect(await transcriptText(page)).not.toContain("Late ops transcript.");
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

/** Labels of the channels currently wearing the unread affordance. */
const unreadLabels = (page: Page): Promise<string[]> =>
	page.$$eval("#channels .channel", (nodes) =>
		nodes
			.filter((node) => node.className.includes("unread"))
			.map((node) => (node.textContent ?? "").trim()),
	);

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

			// This exercises the live-frame path rather than reconnect healing. Wait
			// for OPEN so every post below has an events socket to reach.
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

			// A burst rather than a single post. The OPEN observation above is a
			// check against state that can change before the next line runs: if
			// the socket drops in that window the client reconnects, and the one
			// message posted in the gap is never delivered as a live frame. Three
			// spread across the reconnect make the assertion "at least one landed
			// while a socket was open", which a single dropped frame cannot fail.
			for (const body of [
				"Background chatter.",
				"More chatter.",
				"Still more.",
			]) {
				await h.supervisor.post({ room: "#ops", author: "reviewer", body });
			}

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

	browserTest("a malformed event frame is ignored", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.ensureRoom("#ops");

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"events socket open",
			() =>
				page.evaluate(() =>
					(
						(globalThis as { __consoleSockets?: WebSocket[] })
							.__consoleSockets ?? []
					).some((socket) => socket.readyState === WebSocket.OPEN),
				),
			(open) => open === true,
		);

		h.feed.sendRaw("{");
		h.feed.sendRaw(
			JSON.stringify({ type: "message", message: { room: "#ops" } }),
		);
		await waitFor(
			"valid frame after malformed frame",
			() => unreadLabels(page),
			(labels) => labels.some((label) => label.includes("#ops")),
		);
		expect(errors).toEqual([]);
	});

	browserTest(
		"reconnect reconciles unread from the store, never from a live frame",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			const sameTimestamp = Date.now();
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Open-room baseline.",
				createdAt: sameTimestamp,
			});
			await h.rooms.post({
				room: "#ops",
				author: "reviewer",
				body: "Background baseline.",
				createdAt: sameTimestamp,
			});
			// Equal wall-clock timestamps force unread reconciliation to use
			// monotonic message ids rather than lossy millisecond comparisons.

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"open-room baseline",
				() => transcriptText(page),
				(text) => text.includes("Open-room baseline."),
			);
			// Visit and leave, so both rooms carry a seen cursor and the badge
			// asserted after the outage is that outage's doing, not a leftover.
			await clickInPage(page, '#channels .channel[data-id="#ops"]');
			await waitFor(
				"background baseline",
				() => transcriptText(page),
				(text) => text.includes("Background baseline."),
			);
			await clickInPage(page, '#channels .channel[data-id="#reviews"]');
			await waitFor(
				"open room restored",
				() => transcriptText(page),
				(text) => text.includes("Open-room baseline."),
			);
			await waitFor(
				"nothing unread yet",
				() => unreadLabels(page),
				(labels) => labels.length === 0,
			);
			await waitFor(
				"events socket open",
				() =>
					page.evaluate(() =>
						(
							(globalThis as { __consoleSockets?: WebSocket[] })
								.__consoleSockets ?? []
						).some((socket) => socket.readyState === WebSocket.OPEN),
					),
				(open) => open === true,
			);

			// Isolation, in two parts.
			//
			// First, no live frame may reach the page at all: the daemon polls
			// the store and pushes a `message` frame for anything it finds, and
			// whether that lands before or after the reconnect is a race. From
			// here the proxy withholds every message frame, so whatever the
			// badge below says was learned by a fetch — and socket-open
			// reconciliation is the only code that fetches a background room,
			// so deleting that call leaves nothing that could paint it.
			h.feed.dropMessages = true;
			// Second, the writes must precede the reconnect that is supposed to
			// discover them. Closing starts a backoff this test does not
			// control, so the next handshake is held rather than raced.
			const released = Promise.withResolvers<void>();
			// Both halves of disarming, in one place: clearing `holdConnect`
			// stops holding future handshakes, resolving releases the one
			// already waiting. Idempotent, so cleanup and the happy path can
			// both call it.
			const releaseGate = () => {
				h.feed.holdConnect = null;
				released.resolve();
			};
			// Registered before the gate is armed. A held /api/events fetch is
			// a request the proxy never answers, and `web.stop(true)` in
			// afterEach waits for it — so a throw below must not be able to
			// leave it pending.
			cleanups.push(async function releaseConnectGate() {
				releaseGate();
			});
			h.feed.holdConnect = released.promise;
			const connectsBefore = h.feed.connects;

			try {
				// Exactly one socket — the open one — is closed. Closing every
				// entry schedules a reconnect per entry, and two reconnects
				// mean two reconcile passes racing through the coalescing
				// gate; the assertion below is about the one-reconnect path.
				await page.evaluate(() => {
					const sockets =
						(globalThis as { __consoleSockets?: WebSocket[] })
							.__consoleSockets ?? [];
					sockets
						.find((socket) => socket.readyState === WebSocket.OPEN)
						?.close();
				});
				await waitFor(
					"events socket closed",
					() =>
						page.evaluate(() =>
							(
								(globalThis as { __consoleSockets?: WebSocket[] })
									.__consoleSockets ?? []
							).every((socket) => socket.readyState !== WebSocket.OPEN),
						),
					(closed) => closed === true,
				);

				// Written straight to the store while the page is deaf: both
				// rooms take one, so the open room is tested under the same
				// conditions as the background one rather than by omission.
				await h.rooms.post({
					room: "#ops",
					author: "reviewer",
					body: "Background post during outage.",
					createdAt: sameTimestamp,
				});
				await h.rooms.post({
					room: "#reviews",
					author: "reviewer",
					body: "Open-room post during outage.",
					createdAt: sameTimestamp,
				});

				// Both writes have landed before the gate opens, so the
				// reconnect's reconciliation reads a store that already holds
				// them: a pass is the client's doing, not the scheduler's.
				await waitFor(
					"a reconnect waiting on the gate",
					() => Promise.resolve(h.feed.connects),
					(count) => count > connectsBefore,
					10_000,
				);
			} finally {
				releaseGate();
			}

			await waitFor(
				"events socket reopened",
				() =>
					page.evaluate(() => {
						const sockets = Reflect.get(globalThis, "__consoleSockets");
						return (
							Array.isArray(sockets) &&
							sockets.some(
								(socket) =>
									socket instanceof WebSocket &&
									socket.readyState === WebSocket.OPEN,
							)
						);
					}),
				(open) => open === true,
				10_000,
			);

			const unread = await waitFor(
				"reconciled unread affordance",
				() => unreadLabels(page),
				(list) => list.some((label) => label.includes("#ops")),
				10_000,
			);
			expect(unread.join(" ")).toContain("#ops");
			// The open room took a post in the same outage and is still read:
			// reconciliation skips wherever the operator is looking.
			expect(unread.join(" ")).not.toContain("#reviews");
			// And the open room's transcript is rebuilt over HTTP, which is
			// the other half of what socket-open owes a deaf console.
			await waitFor(
				"reconnected open transcript",
				() => transcriptText(page),
				(text) => text.includes("Open-room post during outage."),
				10_000,
			);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"history in a never-visited room is not unread on the first socket open",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			await h.ensureRoom("#alerts");
			// Deaf from the first paint, so any badge below would be a
			// reconciling fetch's doing and never a live frame's.
			h.feed.dropMessages = true;
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Open-room baseline.",
			});
			// History in rooms this session has never opened. It is not news:
			// nothing was missed here, the operator simply has not read them.
			await h.rooms.post({
				room: "#ops",
				author: "reviewer",
				body: "Ops history.",
			});
			await h.rooms.post({
				room: "#alerts",
				author: "reviewer",
				body: "Alerts history.",
			});

			const { page, errors } = await openPage();
			const initialReconcilePasses = await page.evaluate(
				() =>
					(globalThis as { __consoleReconcilePasses?: number })
						.__consoleReconcilePasses ?? 0,
			);
			expect(initialReconcilePasses).toBe(0);
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"open-room baseline",
				() => transcriptText(page),
				(text) => text.includes("Open-room baseline."),
			);
			// Barriers before the assertion: the baseline is captured before app boot.
			// Waiting for both OPEN and a completed pass proves the buggy first-open
			// pass cannot land afterward.
			await waitFor(
				"events socket open",
				() =>
					page.evaluate(() =>
						(
							(globalThis as { __consoleSockets?: WebSocket[] })
								.__consoleSockets ?? []
						).some((socket) => socket.readyState === WebSocket.OPEN),
					),
				(open) => open === true,
			);
			await waitFor(
				"first reconcile pass completed",
				() =>
					page.evaluate(
						() =>
							(globalThis as { __consoleReconcilePasses?: number })
								.__consoleReconcilePasses ?? 0,
					),
				(count) => count > initialReconcilePasses,
			);
			await waitFor(
				"nothing unread on the first open",
				() => unreadLabels(page),
				(labels) => labels.length === 0,
			);

			// Give one room a cursor, then force a real pass by reconnecting.
			// The visited room is the anchor: once its read has been served the
			// pass has run, so the never-visited room's absence below is a
			// decision rather than a race with a pass that had not started.
			await clickInPage(page, '#channels .channel[data-id="#ops"]');
			await waitFor(
				"ops transcript",
				() => transcriptText(page),
				(text) => text.includes("Ops history."),
			);
			await clickInPage(page, '#channels .channel[data-id="#reviews"]');
			await waitFor(
				"open room restored",
				() => transcriptText(page),
				(text) => text.includes("Open-room baseline."),
			);
			await page.evaluate(() => {
				const sockets =
					(globalThis as { __consoleSockets?: WebSocket[] }).__consoleSockets ??
					[];
				sockets.find((socket) => socket.readyState === WebSocket.OPEN)?.close();
			});
			await waitFor(
				"the visited room reconciled",
				() => Promise.resolve(h.feed.reconcileReads.get("#ops") ?? 0),
				(reads) => reads > 0,
				10_000,
			);

			// The pass ran and still left the unvisited room alone — and never
			// even asked about it, so the badge is absent because the room was
			// out of scope, not because its read happened to answer nothing.
			expect(h.feed.reconcileReads.has("#alerts")).toBe(false);
			expect((await unreadLabels(page)).join(" ")).not.toContain("#alerts");
			// The visited room is at its cursor: nothing arrived after it.
			expect((await unreadLabels(page)).join(" ")).not.toContain("#ops");
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"an unreadable room costs no other room its mark and is retried",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");
			await h.ensureRoom("#alerts");
			// Deaf from the first paint, so every badge below is a reconciling
			// fetch's doing and never a live frame's.
			h.feed.dropMessages = true;
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Open-room baseline.",
			});
			await h.rooms.post({
				room: "#ops",
				author: "reviewer",
				body: "Ops baseline.",
			});
			await h.rooms.post({
				room: "#alerts",
				author: "reviewer",
				body: "Alerts baseline.",
			});

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"open-room baseline",
				() => transcriptText(page),
				(text) => text.includes("Open-room baseline."),
			);
			// Visit both background rooms and leave, so each carries a seen
			// cursor: reconciliation reads what was missed, and a room nobody
			// has opened has missed nothing.
			await clickInPage(page, '#channels .channel[data-id="#ops"]');
			await waitFor(
				"ops baseline",
				() => transcriptText(page),
				(text) => text.includes("Ops baseline."),
			);
			await clickInPage(page, '#channels .channel[data-id="#alerts"]');
			await waitFor(
				"alerts baseline",
				() => transcriptText(page),
				(text) => text.includes("Alerts baseline."),
			);
			await clickInPage(page, '#channels .channel[data-id="#reviews"]');
			await waitFor(
				"open room restored",
				() => transcriptText(page),
				(text) => text.includes("Open-room baseline."),
			);

			// `#ops` cannot be reconciled; every other room is healthy. One
			// room's failure must cost no other room its mark. The fault is
			// scoped to the marked reconcile read, so selecting `#ops` above
			// still worked — otherwise this would prove the wrong thing.
			h.feed.faultyRooms.add("#ops");
			// Real unseen activity in the failing room: this is what the retry
			// must eventually find, so the healed pass is proved by a badge
			// rather than only by a notice going quiet.
			await h.rooms.post({
				room: "#ops",
				author: "reviewer",
				body: "Missed while unreadable.",
			});
			await h.rooms.post({
				room: "#alerts",
				author: "reviewer",
				body: "Alert while away.",
			});
			await page.evaluate(() => {
				const sockets =
					(globalThis as { __consoleSockets?: WebSocket[] }).__consoleSockets ??
					[];
				sockets.find((socket) => socket.readyState === WebSocket.OPEN)?.close();
			});

			// A join that rejected on the first failure would never repaint,
			// and `#alerts` would stay unmarked; this is the assertion that
			// catches it.
			const unread = await waitFor(
				"the readable room reconciled",
				() => unreadLabels(page),
				(labels) => labels.some((label) => label.includes("#alerts")),
				10_000,
			);
			expect(unread.join(" ")).toContain("#alerts");
			// Unknown is not read, and unknown is not unread either: a room
			// whose read failed is left exactly as it stands.
			expect(unread.join(" ")).not.toContain("#ops");

			// And the failure is said out loud, so a stale mark is not silent.
			const notice = await waitFor(
				"the stale-room notice",
				() => page.$eval("#notice", (node) => node.textContent ?? ""),
				(text) => text.includes("#ops"),
				10_000,
			);
			expect(notice).toContain("#ops");

			// Heal the room, then force a second socket open. The retry is the
			// contract: a failure that stopped reconciling that room would
			// leave `#ops` unmarked forever, because nothing else fetches it.
			const before = h.feed.reconcileReads.get("#ops") ?? 0;
			h.feed.faultyRooms.delete("#ops");
			await page.evaluate(() => {
				const sockets =
					(globalThis as { __consoleSockets?: WebSocket[] }).__consoleSockets ??
					[];
				sockets.find((socket) => socket.readyState === WebSocket.OPEN)?.close();
			});

			const healed = await waitFor(
				"the retried room marked unread",
				() => unreadLabels(page),
				(labels) => labels.some((label) => label.includes("#ops")),
				10_000,
			);
			expect(healed.join(" ")).toContain("#ops");
			// The mark came from a fresh read of that specific room, not from
			// a repaint of state the first pass had already guessed.
			expect(h.feed.reconcileReads.get("#ops") ?? 0).toBeGreaterThan(before);
			// Nothing stale is left to report, so the console retracts its own
			// words — and only its own.
			await waitFor(
				"the notice retracted",
				() => page.$eval("#notice", (node) => node.textContent ?? ""),
				(text) => text === "",
				10_000,
			);
			// The injected 502 is a real failed request, so Chrome logs it
			// whether or not the page handled it. Excluded by prefix, exactly
			// as the refused-write tests above do — everything else must be
			// empty, so a rejection nobody owned still fails here.
			expect(
				errors.filter((entry) => !entry.startsWith("Failed to load resource")),
			).toEqual([]);
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
			const root = await h.rooms.post({
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

			// The current composer is labelled; open a real thread before checking
			// its conditionally rendered composer.
			expect(
				await page.$eval("#composer-input", (node) =>
					node.getAttribute("aria-label"),
				),
			).not.toBe("");
			await page.click(`#messages .message[data-id="${root.id}"] .thread-open`);
			await page.waitForSelector("#thread-composer-input", { visible: true });
			expect(
				await page.$eval("#thread-composer-input", (node) =>
					node.getAttribute("aria-label"),
				),
			).not.toBe("");

			// The thread pane is a named complementary region with a labeled close.
			const thread = await page.$eval("aside#thread", (node) => ({
				role: node.getAttribute("role") ?? "",
				label: node.getAttribute("aria-label") ?? "",
			}));
			expect(thread.role).toBe("complementary");
			expect(thread.label.length).toBeGreaterThan(0);
			expect(
				await page.$eval("#thread-close", (node) => {
					const label = node.getAttribute("aria-label") ?? "";
					return label || (node.textContent ?? "").trim();
				}),
			).not.toBe("");

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
			// Tab through preceding visible actions until the roving room option.
			let onOption = await focusProbe(page);
			for (
				let presses = 0;
				presses < 8 && !(onOption?.className ?? "").includes("channel");
				presses += 1
			) {
				await page.keyboard.press("Tab");
				onOption = await focusProbe(page);
			}
			expect(onOption?.className ?? "").toContain("channel");
			expect(onOption?.text ?? "").toContain("#reviews");
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

			// A keyboard reply posts from here, and lands in the thread: Enter
			// in the thread composer sends without a pointer, and the composer
			// carries the open root's id so the reply renders inside the pane
			// instead of appearing as a second root in the transcript.
			await focusInPage(page, "#thread-composer-input");
			await page.keyboard.type("Reply from the keyboard.");
			await page.keyboard.press("Enter");
			await waitFor(
				"keyboard thread reply in the pane",
				() =>
					page
						.$eval("#thread-messages", (node) => node.textContent ?? "")
						.catch(() => ""),
				(t) => t.includes("Reply from the keyboard."),
			);
			expect(await transcriptText(page)).not.toContain(
				"Reply from the keyboard.",
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
			expect(kept?.className ?? "").toContain("thread-open");
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
		const state = await page.$eval("#state:not([hidden])", (node) => ({
			role: node.getAttribute("role") ?? "",
			actionTag: node.querySelector(".state-action")?.tagName ?? "",
		}));
		expect(state.role).toBe("status");
		expect(state.actionTag).toBe("BUTTON");
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

		// Reach an option by keyboard and observe a painted outline.

		// Reach a room option through the real keyboard order.
		let focused = await focusProbe(page);
		for (
			let presses = 0;
			presses < 8 && !(focused?.className ?? "").includes("channel");
			presses += 1
		) {
			await page.keyboard.press("Tab");
			focused = await focusProbe(page);
		}
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
		"visible text tokens meet WCAG AAA on every surface that carries them",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForSelector("#messages");

			const pairs: [string, string][] = [
				["--text-primary", "--surface-0"],
				["--text-primary", "--surface-1"],
				["--text-primary", "--surface-2"],
				["--text-muted", "--surface-0"],
				["--text-muted", "--surface-1"],
				["--text-muted", "--surface-2"],
				["--primary", "--surface-0"],
				["--primary", "--surface-1"],
				["--primary", "--surface-2"],
				["--role-agent", "--surface-0"],
				["--role-you", "--surface-0"],
				["--role-system", "--surface-0"],
				["--primary-foreground", "--primary"],
			];
			const tokens = pairs.flat();
			const resolved = await page.evaluate((names: string[]) => {
				const canvas = document.createElement("canvas") as unknown as {
					width: number;
					height: number;
					getContext(kind: "2d"): {
						fillStyle: string;
						fillRect(x: number, y: number, width: number, height: number): void;
						getImageData(
							x: number,
							y: number,
							width: number,
							height: number,
						): {
							data: ArrayLike<number>;
						};
					} | null;
				};
				canvas.width = 1;
				canvas.height = 1;
				const context = canvas.getContext("2d");
				if (context === null) throw new Error("Missing 2D canvas context");
				const out: Record<string, string> = {};
				for (const name of names) {
					const node = document.createElement("div");
					node.style.color = `var(${name})`;
					document.body.append(node);
					context.fillStyle = getComputedStyle(node).color;
					context.fillRect(0, 0, 1, 1);
					const pixel = context.getImageData(0, 0, 1, 1).data;
					out[name] = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
					node.remove();
				}
				return out;
			}, tokens);

			for (const [text, surface] of pairs) {
				expect(
					contrastRatio(resolved[text], resolved[surface]),
					`${text} on ${surface} must meet WCAG AAA`,
				).toBeGreaterThanOrEqual(7);
			}
			expect(
				contrastRatio("rgb(120, 120, 120)", "rgb(140, 140, 140)"),
			).toBeLessThan(4.5);
			expect(errors).toEqual([]);
		},
	);

	browserTest("reduced motion removes non-essential animation", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

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

// ── Repaint stability (T-1615) ───────────────────────────────────────────────

/** The emoji segment of the focused chip's label ("👀 2" -> "👀"). */
const focusedEmoji = async (page: Page): Promise<string> => {
	const probe = await focusProbe(page);
	return (probe?.text ?? "").split(" ")[0] ?? "";
};

/**
 * Scroll geometry of the transcript, for the sticky-bottom assertions.
 *
 * The repo has no DOM lib, so the element's scroll box is unexpressible
 * here; puppeteer hands back the real `HTMLElement` and only these three
 * numbers are read off it.
 */
const scrollState = (page: Page) =>
	page.$eval("#messages", (node) => {
		const box: {
			scrollTop: number;
			scrollHeight: number;
			clientHeight: number;
		} = node as unknown as {
			scrollTop: number;
			scrollHeight: number;
			clientHeight: number;
		};
		return {
			top: box.scrollTop,
			fromBottom: box.scrollHeight - box.scrollTop - box.clientHeight,
		};
	});

/** Fill the transcript until it overflows, so scroll position is meaningful. */
async function overflowingRoom(rooms: RoomStore): Promise<void> {
	for (let i = 0; i < 30; i += 1) {
		await rooms.post({
			room: "#reviews",
			author: i % 2 === 0 ? "reviewer" : "second-agent",
			body: `Filler line ${i} to force the transcript to overflow.`,
		});
	}
}

describe("repaint stability", () => {
	browserTest(
		"a repaint keeps focus on the same emoji chip, not the ordinal neighbor",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const posted = await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Three chips.",
			});
			await h.rooms.react(posted.id, "reviewer", "👀");
			await h.rooms.react(posted.id, "second-agent", "✅");
			await h.rooms.react(posted.id, "third-agent", "🚀");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			const chips = await waitFor(
				"three chips",
				() => renderedReactions(page, posted.id),
				(list) => list.length === 3,
			);
			const [first, second] = chips.map((chip) => chip.split(" ")[0] ?? "");

			// Focus the middle chip by its own identity, not its position.
			await focusInPage(
				page,
				`#messages .message[data-id="${posted.id}"] .reaction:nth-of-type(2)`,
			);
			expect(await focusedEmoji(page)).toBe(second);

			// Out-of-band: the chip *ahead* of the focused one disappears, so
			// every ordinal below it shifts by one. A repaint keyed on the
			// ordinal lands on the third chip — a control the operator never
			// chose, and one whose click posts a different reaction.
			await h.rooms.unreact(posted.id, "reviewer", first);
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Repaint trigger.",
			});
			await waitFor(
				"repaint with two chips",
				() => renderedReactions(page, posted.id),
				(list) => list.length === 2,
			);

			expect(await focusedEmoji(page)).toBe(second);
			expect(errors).toEqual([]);
		},
	);

	browserTest(
		"a chip whose identity vanished drops focus to the container, never a sibling",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			const posted = await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Two chips.",
			});
			await h.rooms.react(posted.id, "reviewer", "👀");
			await h.rooms.react(posted.id, "second-agent", "✅");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"two chips",
				() => renderedReactions(page, posted.id),
				(list) => list.length === 2,
			);

			await focusInPage(
				page,
				`#messages .message[data-id="${posted.id}"] .reaction:nth-of-type(1)`,
			);
			expect(await focusedEmoji(page)).toBe("👀");

			// The focused chip itself is what vanishes. Falling back to the
			// row's first remaining control would silently re-point the
			// keyboard at ✅ — a different reaction, one Enter away.
			await h.rooms.unreact(posted.id, "reviewer", "👀");
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: "Repaint trigger.",
			});
			await waitFor(
				"repaint with one chip",
				() => renderedReactions(page, posted.id),
				(list) => list.length === 1,
			);

			// The container itself is an acceptable landing place; a sibling
			// chip is not — that is the wrong-target defect this guards.
			const landed = await focusProbe(page);
			expect(landed?.className ?? "").not.toContain("reaction");
			expect(["messages", ""]).toContain(landed?.id ?? "");
			expect(errors).toEqual([]);
		},
	);

	browserTest("a scrolled-up reader keeps their position", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await overflowingRoom(h.rooms);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"transcript",
			() => transcriptText(page),
			(t) => t.includes("Filler line 29"),
		);
		await waitFor(
			"transcript overflows",
			() => scrollState(page),
			(s) => s.fromBottom + s.top > 0,
		);

		await page.$eval("#messages", (node) => {
			(node as unknown as { scrollTop: number }).scrollTop = 0;
		});

		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Landed while reading history.",
		});
		await waitFor(
			"repaint",
			() => transcriptText(page),
			(t) => t.includes("Landed while reading history."),
		);

		// Slamming to the bottom yanks the reader out of the history they
		// were reading, with no way back to where they were.
		expect((await scrollState(page)).top).toBe(0);
		expect(errors).toEqual([]);
	});

	browserTest("a reader at the bottom stays pinned there", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await overflowingRoom(h.rooms);

		const { page, errors } = await openPage();
		await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
		await waitFor(
			"pinned to the bottom on first paint",
			() => scrollState(page),
			(s) => s.fromBottom < 4,
		);

		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Newest line of all.",
		});
		await waitFor(
			"repaint",
			() => transcriptText(page),
			(t) => t.includes("Newest line of all."),
		);

		expect((await scrollState(page)).fromBottom).toBeLessThan(4);
		expect(errors).toEqual([]);
	});

	browserTest("a thread-pane repaint keeps focus in the pane", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root question.",
		});
		const reply = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Threaded answer.",
			parentId: root.id,
		});
		await h.rooms.react(reply.id, "reviewer", "👀");

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

		const chip = `#thread-messages .message[data-id="${reply.id}"] .reaction`;
		await page.waitForSelector(chip, { timeout: 10_000 });
		await focusInPage(page, chip);
		expect((await focusProbe(page))?.inThread).toBe(true);

		// The pane repaints inside the same refresh() as the transcript, and
		// carried no focus protection of its own.
		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Second reply.",
			parentId: root.id,
		});
		await waitFor(
			"thread repaint",
			() =>
				page
					.$eval("#thread-messages", (node) => node.textContent ?? "")
					.catch(() => ""),
			(t) => t.includes("Second reply."),
		);

		const kept = await focusProbe(page);
		expect(kept?.inThread).toBe(true);
		expect(kept?.messageId).toBe(String(reply.id));
		expect(errors).toEqual([]);
	});

	browserTest(
		"a channel repaint restores the focused channel, not the roving one",
		async () => {
			const h = await harness();
			await h.ensureRoom("#reviews");
			await h.ensureRoom("#ops");

			const { page, errors } = await openPage();
			await page.goto(h.consoleUrl(), { waitUntil: "domcontentloaded" });
			await waitFor(
				"two channel options",
				() => page.$$eval("#channels .channel", (nodes) => nodes.length),
				(count) => count >= 2,
			);

			// #reviews is open, so it owns the roving tabindex; focus sits on
			// #ops. Restoring "the option in the tab order" therefore restores
			// a different option than the one the operator was on.
			await focusInPage(page, "#channels li:nth-of-type(2) .channel");
			expect((await focusProbe(page))?.text ?? "").toContain("#ops");

			await h.rooms.post({
				room: "#ops",
				author: "reviewer",
				body: "Background activity.",
			});
			await waitFor(
				"unread repaint",
				() =>
					page.$$eval("#channels .channel.unread", (nodes) =>
						nodes.map((n) => (n.textContent ?? "").trim()),
					),
				(list) => list.length === 1,
			);

			expect((await focusProbe(page))?.text ?? "").toContain("#ops");
			expect(errors).toEqual([]);
		},
	);
});
