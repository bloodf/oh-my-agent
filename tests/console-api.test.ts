/**
 * RED tests for src/daemon/console-api.ts
 *
 * Public API under test: startConsoleApi(options) -> ConsoleApi
 *
 * Architecture contract (§4.6, ADR-009). The console API is the browser-facing
 * half of the operator surface. It is deliberately *not* a CRUD layer over
 * SQLite:
 *
 *  - every post goes through `Supervisor.post()`, because the supervisor is
 *    what wakes subscribed peers; a write that stopped at the store would
 *    leave a running agent deaf (ADR-009 consequences);
 *  - the console posts as the human, so a write naming a registered peer as
 *    author is refused — a forgeable author makes a transcript worthless;
 *  - it binds loopback and refuses any request without the operator token, so
 *    a daemon on a shared machine does not hand its rooms to any local
 *    process that guesses the port;
 *  - a WebSocket pushes new messages and reactions, including ones an agent
 *    posted through the control socket rather than through this API.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ConsoleApi, ConsoleEvent } from "../src/daemon/console-api";
import { startConsoleApi } from "../src/daemon/console-api";
import { bootDaemon } from "../src/daemon/main";
import { createOperations } from "../src/daemon/operations";
import type { PeerStoreRoots } from "../src/daemon/peer-store";
import { createPeerStore } from "../src/daemon/peer-store";
import { Scheduler } from "../src/daemon/scheduler";
import type { PeerRecord } from "../src/daemon/socket";
import { Supervisor } from "../src/daemon/supervisor";
import { RoomStore } from "../src/rooms/store";
import {
	fingerprintPeerDefinition,
	parsePeerDefinition,
} from "../src/shared/agent-definition";
import type { RoomInfo } from "../src/shared/protocol";
import { controlCall, operatorToken } from "./fixtures/control-client";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOKEN = "operator-token";

/** Records what the supervisor asked the worker to do. */
function stubWorker(name = "reviewer", fingerprint?: string) {
	const prompts: string[] = [];
	let state: "running" | "parked" | "stopped" = "running";
	/**
	 * Stderr the log tail reads. A worker with no `stderr()` answers an empty
	 * tail, which a logs assertion cannot tell apart from a working route
	 * reading a quiet worker — so the stub carries real lines.
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

/** A definition file the production parser accepts, as the console writes it. */
function peerDocument(name: string, rooms: string[]): string {
	const frontmatter = [
		`name: ${name}`,
		`description: ${name} peer for console management tests.`,
		`spawns: ${JSON.stringify(["scout"])}`,
		...(rooms.length === 0 ? [] : [`rooms: ${JSON.stringify(rooms)}`]),
	].join("\n");
	return `---\n${frontmatter}\n---\nYou are ${name}.\n`;
}

/**
 * The daemon's composition, minus the process: a real store, a real
 * supervisor, and the same `knownRooms` index and `ensureRoom` closure
 * `src/daemon/main.ts` builds (main.ts:265-270). The console API is handed
 * exactly the slice of `DaemonContext` it is allowed to touch.
 */
async function harness(options: { pollIntervalMs?: number } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "oh-my-agent-console-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const rooms = await RoomStore.open(join(dir, "rooms.db"));
	cleanups.push(() => rooms.close());

	const scheduler = new Scheduler({
		now: () => Date.now(),
		setTimer: () => 0,
		clearTimer: () => {},
	});
	scheduler.start();

	// The private store the console writes definitions into, and the same
	// store the supervisor re-reads for T-505 staleness — one source of truth,
	// exactly as `src/daemon/main.ts` composes it.
	const roots: PeerStoreRoots = {
		user: join(dir, "user", "agents"),
		project: join(dir, "project", "agents"),
	};
	await mkdir(roots.user, { recursive: true });
	await mkdir(roots.project, { recursive: true });
	const peerStore = createPeerStore(roots);

	/** Rebuilds the supervisor asked for; empty is "no restart happened". */
	const respawns: string[] = [];

	/**
	 * Where the supervisor's transitions go, and the ordering that forces the
	 * seam: the supervisor is constructed before the console exists, so it
	 * forwards through a mutable reference that stays a no-op until
	 * `startConsoleApi` has returned a handle to point it at.
	 */
	let sink: ((event: ConsoleEvent) => void) | undefined;

	const supervisor = new Supervisor({
		rooms,
		scheduler,
		now: () => Date.now(),
		// Staleness wired on, as the daemon wires it: a membership edit that
		// looked like a policy edit would rebuild here, and the acceptance is
		// that it does not.
		peers: peerStore,
		respawn: async ({ peerName, definition }) => {
			respawns.push(peerName);
			return stubWorker(peerName, fingerprintPeerDefinition(definition)).worker;
		},
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
	 * Kills the wired tree performed, so a test can tell a real cascade from
	 * the fallback that stops the named worker alone.
	 */
	const kills: { name: string; keepChildren: boolean }[] = [];
	/** Bumps the daemon's account layer was asked for, and what it resumed. */
	const bumps: { accountId: string; budgetUsd: number }[] = [];

	/**
	 * The very seam `./main` composes, over this harness's own peer index:
	 * the routes under test drive `operations.ts` rather than a console-local
	 * copy of kill/inject/logs/bump.
	 */
	const operations = createOperations({
		rooms,
		supervisor,
		peers,
		killPeer: async (name, killOptions) => {
			kills.push({ name, keepChildren: killOptions.keepChildren });
			// Cascade as the daemon does: the named peer plus its whole
			// subtree, transitively, unless the caller asked to keep the
			// children. Stopping only the direct children would make this
			// harness disagree with `main.ts` about what a cascade reaches.
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
			bumps.push({ accountId, budgetUsd });
			// Snapshot first, exactly as `main.ts` does: "resumed" means a peer
			// the bump actually restarted. Reporting every running peer on the
			// account would claim credit for ones that were never parked.
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
		daemonLog: async () => "daemon line one\ndaemon line two\n",
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
		...(options.pollIntervalMs === undefined
			? {}
			: { pollIntervalMs: options.pollIntervalMs }),
	});
	cleanups.push(() => api.close());
	// Nameable only after construction, which is the whole reason the console
	// exposes a handle method rather than a start option. `emit` and not
	// `publish`: the supervisor's transitions go through the swappable sink,
	// which defaults to the socket broadcast.
	sink = api.emit;

	/**
	 * Register a peer with the supervisor and index it as the daemon does,
	 * backed by a real definition file so the staleness check has something to
	 * compare against.
	 */
	const registerPeer = async (
		name: string,
		roomIds: string[],
		peerOptions: { parent?: string } = {},
	): Promise<{
		prompts: string[];
		state: () => string;
		stderr: string[];
		park: () => Promise<void>;
	}> => {
		const path = join(roots.project, `${name}.md`);
		await writeFile(path, peerDocument(name, roomIds), "utf8");
		const definition = parsePeerDefinition(path, await readFile(path, "utf8"));
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
			...(peerOptions.parent === undefined
				? {}
				: { parent: peerOptions.parent }),
		});
		return {
			prompts: stub.prompts,
			state: () => stub.worker.state,
			stderr: stub.stderr,
			park: () => stub.worker.park(),
		};
	};

	/**
	 * A metered peer, so budget transitions have a real account to move.
	 * `budgetUsd` is the ceiling the registry warns and parks against.
	 */
	const registerMeteredPeer = async (
		name: string,
		accountId: string,
		budgetUsd: number,
	): Promise<{ state: () => string }> => {
		await writeFile(
			join(roots.project, `${name}.md`),
			peerDocument(name, []),
			"utf8",
		);
		const stub = stubWorker(name);
		await supervisor.register({
			worker: stub.worker,
			accountId,
			mode: "metered",
			budgetUsd,
			rooms: [],
		});
		peers.set(name, { worker: stub.worker, accountId, rooms: [] });
		// Only the state: a quota park is the supervisor's own transition over
		// its account registry, so moving this worker's state by hand would
		// stage a park the supervisor does not know about and could not
		// resume.
		return { state: () => stub.worker.state };
	};

	const call = (
		path: string,
		init: RequestInit & { token?: string | null } = {},
	): Promise<Response> => {
		const { token = TOKEN, ...rest } = init;
		const headers = new Headers(rest.headers);
		if (token !== null) headers.set("Authorization", `Bearer ${token}`);
		if (rest.body !== undefined)
			headers.set("Content-Type", "application/json");
		return fetch(`${api.url}${path}`, { ...rest, headers });
	};

	/** Definitions as a cold daemon boot would read them. */
	const reload = () => createPeerStore(roots).list();

	return {
		api,
		rooms,
		roots,
		supervisor,
		peers,
		peerStore,
		respawns,
		knownRooms,
		ensureRoom,
		registerPeer,
		registerMeteredPeer,
		reload,
		call,
		operations,
		/** What the wired tree was asked to kill, and whether it cascaded. */
		kills,
		/** What the account layer was asked to bump. */
		bumps,
		/**
		 * Emit as the supervisor does, through the same seam: this is what
		 * `SupervisorDeps.emit` reaches, so a test drives the daemon-side
		 * emitters without owning `main.ts`.
		 */
		emit: (event: ConsoleEvent) => sink?.(event),
	};
}

/**
 * Resolve with the next parsed frame, or reject if none arrives in time.
 *
 * The timer is a failure bound, not a wait: every passing path resolves on the
 * real `message` event the moment it lands, so the suite pays the timeout only
 * when the assertion is "no frame arrives" or the code under test is broken.
 */
function nextFrame(socket: WebSocket, timeoutMs = 2_000): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const onMessage = (event: MessageEvent) => {
		clearTimeout(timer);
		socket.removeEventListener("message", onMessage);
		resolve(JSON.parse(String(event.data)));
	};
	const timer = setTimeout(() => {
		socket.removeEventListener("message", onMessage);
		reject(new Error("no websocket frame within timeout"));
	}, timeoutMs);
	socket.addEventListener("message", onMessage);
	return promise;
}

/** Resolve on the socket's own `open` event; the timer only bounds failure. */
function opened(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(
		() => reject(new Error("websocket did not open")),
		timeoutMs,
	);
	socket.addEventListener("open", () => {
		clearTimeout(timer);
		resolve();
	});
	socket.addEventListener("error", () => {
		clearTimeout(timer);
		reject(new Error("websocket errored"));
	});
	return promise;
}

/**
 * `REACTION_WINDOW` as the poller applies it (`console-api.ts`). Pinned here
 * rather than imported: importing it would make this test track whatever the
 * production value became, so a bound that silently shrank would still pass
 * while consoles started fabricating removals.
 */
const REACTION_WINDOW = 200;

/** Every frame the socket has delivered so far, parsed and in order. */
function collectFrames(socket: WebSocket): ConsoleEvent[] {
	const frames: ConsoleEvent[] = [];
	socket.addEventListener("message", (event) => {
		frames.push(JSON.parse(String(event.data)) as ConsoleEvent);
	});
	return frames;
}

/** Poll a condition until it holds; the timeout only bounds failure. */
async function until(
	label: string,
	holds: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!holds()) {
		if (Date.now() > deadline)
			throw new Error(`Timed out waiting for ${label}`);
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 10);
		await tick.promise;
	}
}

// ── Operator token ───────────────────────────────────────────────────────────

describe("operator token", () => {
	test("binds loopback by default", async () => {
		const h = await harness();
		// A console reachable from the network would hand every room to anyone
		// who can route to the host; §4.6 keeps it beside the unix socket.
		expect(h.api.hostname).toBe("127.0.0.1");
		expect(h.api.url).toContain("127.0.0.1");
	});

	test("refuses a request with no operator token", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", { token: null });

		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("unauthorized");
	});

	test("refuses a request with the wrong operator token", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", { token: "not-the-token" });

		expect(res.status).toBe(401);
	});

	test("refuses a token that is a prefix of the real one", async () => {
		const h = await harness();

		// A length-only or prefix comparison would let this through.
		const res = await h.call("/api/agents", {
			token: TOKEN.slice(0, TOKEN.length - 1),
		});

		expect(res.status).toBe(401);
	});

	test("accepts the operator token", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			agents: {
				name: string;
				state: string;
				account: string;
				rooms: string[];
			}[];
		};
		// Membership rides along with status: the console's per-channel toggle
		// has to render the current state, and a second round trip per agent
		// to learn it would be a list the UI could show inconsistently.
		expect(body.agents).toEqual([
			{
				name: "reviewer",
				state: "running",
				account: "acct-1",
				rooms: ["#reviews"],
			},
		]);
	});

	test("an agent's listed rooms follow a membership change", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});

		const res = await h.call("/api/agents");
		const body = (await res.json()) as { agents: { rooms: string[] }[] };
		expect(body.agents[0]?.rooms).toEqual(["#ops", "#reviews"]);
	});

	test("a defined but not-yet-running agent is listed as stopped", async () => {
		const h = await harness();

		await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "researcher",
				description: "Researches things.",
				spawns: ["scout"],
				rooms: ["#research"],
				body: "You are the researcher.",
			}),
		});

		// It has no worker until the next daemon start, and an operator who
		// just created it must still see that it exists.
		const res = await h.call("/api/agents");
		const body = (await res.json()) as {
			agents: {
				name: string;
				state: string;
				account: string;
				rooms: string[];
			}[];
		};
		expect(body.agents).toContainEqual({
			name: "researcher",
			state: "stopped",
			account: "",
			rooms: ["#research"],
		});
	});

	test("refuses a websocket with no operator token", async () => {
		const h = await harness();
		const url = `${h.api.url.replace("http://", "ws://")}/api/events`;

		const socket = new WebSocket(url);
		const closed = new Promise<number>((resolve) => {
			socket.addEventListener("close", (event) => resolve(event.code));
			socket.addEventListener("error", () => resolve(-1));
		});

		await expect(opened(socket, 500)).rejects.toThrow();
		expect(await closed).not.toBe(1000);
		socket.close();
	});
});

// ── Channels ─────────────────────────────────────────────────────────────────

describe("channels", () => {
	test("creating a channel over HTTP makes it visible in the list", async () => {
		const h = await harness();

		const created = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "#reviews" }),
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({
			channel: { id: "#reviews", kind: "channel", name: "#reviews" },
		});

		const listed = await h.call("/api/channels");
		const body = (await listed.json()) as { channels: RoomInfo[] };
		expect(body.channels).toContainEqual({
			id: "#reviews",
			kind: "channel",
			name: "#reviews",
		});
	});

	test("a channel created over HTTP is visible to a worker", async () => {
		const h = await harness();

		await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "#reviews" }),
		});
		// Registering after the fact must find the room already there: the
		// supervisor subscribes the peer to a room the console created.
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Look at this.",
		});

		expect(stub.prompts).toHaveLength(1);
		expect(stub.prompts[0]).toContain("Look at this.");
	});

	test("a DM id is created as a dm, not a channel", async () => {
		const h = await harness();

		const created = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "@reviewer" }),
		});

		expect(await created.json()).toEqual({
			channel: { id: "@reviewer", kind: "dm", name: "@reviewer" },
		});
	});

	test("an empty channel id is rejected", async () => {
		const h = await harness();

		const res = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "  " }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_request");
	});
});

// ── Messages ─────────────────────────────────────────────────────────────────

describe("messages", () => {
	test("posting over HTTP wakes a subscribed peer", async () => {
		const h = await harness();
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Please review PR 12." }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: { id: number; author: string; body: string };
		};
		expect(body.message.author).toBe("@you");
		expect(body.message.body).toBe("Please review PR 12.");

		// The acceptance-critical bit: a write that stopped at RoomStore.post
		// would leave this empty, and the agent would never notice.
		expect(stub.prompts).toHaveLength(1);
		expect(stub.prompts[0]).toContain("Please review PR 12.");
	});

	test("messages carry the store's thread and reaction fields", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root.",
		});
		await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Reply.",
			parentId: root.id,
		});
		await h.rooms.react(root.id, "reviewer", "👀");

		const res = await h.call("/api/channels/%23reviews/messages");
		const body = (await res.json()) as {
			messages: {
				id: number;
				parentId: number | null;
				threadRootId: number | null;
				replyCount: number;
				reactions: { actor: string; emoji: string }[];
			}[];
		};

		expect(body.messages).toHaveLength(2);
		expect(body.messages[0]).toMatchObject({
			id: root.id,
			parentId: null,
			replyCount: 1,
			reactions: [{ actor: "reviewer", emoji: "👀" }],
		});
		expect(body.messages[1]).toMatchObject({
			parentId: root.id,
			threadRootId: root.id,
		});
	});

	test("a posted reply lands in the parent's thread", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root question.",
		});

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Threaded answer.", parentId: root.id }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: {
				id: number;
				parentId: number | null;
				threadRootId: number | null;
			};
		};
		// The whole point of the route: parentage survives the trip through the
		// supervisor into the store, so the reply is in the thread and not a
		// second root beside it.
		expect(body.message.parentId).toBe(root.id);
		expect(body.message.threadRootId).toBe(root.id);
	});

	test("a reply is read back by its own parentage, not by body alone", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const root = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Root question.",
		});
		// The same words as a root and as a reply: a read-back that matched on
		// author and body alone would hand back whichever landed last.
		await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Same words." }),
		});

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Same words.", parentId: root.id }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: { parentId: number | null; threadRootId: number | null };
		};
		expect(body.message.parentId).toBe(root.id);
		expect(body.message.threadRootId).toBe(root.id);
	});

	test("a parentId in another room is a 400", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		await h.ensureRoom("#ops");
		const elsewhere = await h.rooms.post({
			room: "#ops",
			author: "@you",
			body: "Not this room.",
		});

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Reply.", parentId: elsewhere.id }),
		});

		// The store owns the rule; the route only has to surface its refusal
		// in the store's own words rather than answering 500.
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("invalid_request");
		expect(body.error.message).toContain("MESSAGE_NOT_IN_ROOM");

		// And nothing landed.
		const messages = await h.rooms.listMessages("#reviews", {});
		expect(messages).toHaveLength(0);
	});

	test("an unknown parentId is a 400", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Reply.", parentId: 9999 }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_request");
	});

	test("a malformed parentId is refused before the store sees it", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		for (const parentId of [0, -1, 1.5, "1", true, {}]) {
			const res = await h.call("/api/channels/%23reviews/messages", {
				method: "POST",
				body: JSON.stringify({ body: "Reply.", parentId }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("invalid_request");
		}

		expect(await h.rooms.listMessages("#reviews", {})).toHaveLength(0);
	});

	test("an absent or null parentId posts a root", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "A root.", parentId: null }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			message: { parentId: number | null };
		};
		expect(body.message.parentId).toBeNull();
	});

	test("a supervisor failure stays a 500, not a caller error", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		// Only the store's parentage rules are the caller's fault. A delivery
		// fault is the daemon's, and reporting it as 400 would tell an
		// operator to fix a message that was never wrong.
		h.supervisor.post = async () => {
			throw new Error("worker socket closed");
		};

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Please review PR 12." }),
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("internal");
		expect(body.error.message).toContain("worker socket closed");
	});

	test("a message that does not land is a 500, not a caller error", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		// A post the supervisor swallows silently leaves the read-back empty.
		// That is a daemon fault too, and the 400 mapping must not absorb it.
		h.supervisor.post = async () => [];

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "Please review PR 12." }),
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("internal");
		expect(body.error.message).toContain("did not land");
	});

	test("messages paginate with afterId and limit", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const first = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "One.",
		});
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Two." });
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Three." });

		const res = await h.call(
			`/api/channels/%23reviews/messages?afterId=${first.id}&limit=1`,
		);
		const body = (await res.json()) as { messages: { body: string }[] };

		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]?.body).toBe("Two.");
	});

	test("reading an unknown channel is a 404", async () => {
		const h = await harness();

		const res = await h.call("/api/channels/%23nope/messages");

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("an empty message body is rejected", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ body: "   " }),
		});

		expect(res.status).toBe(400);
	});
});

// ── Attribution coercion (ADR-014) ───────────────────────────────────────────

describe("console attribution", () => {
	test("a write claiming a registered peer as author is stored as the human", async () => {
		const h = await harness();
		const stub = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "reviewer", body: "I approve myself." }),
		});

		// ADR-014: the field stays accepted for compatibility and is ignored,
		// so an old client keeps working and forgery is simply not honored.
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			message: { author: "@you", body: "I approve myself." },
		});

		const messages = await h.rooms.listMessages("#reviews", {});
		expect(messages).toMatchObject([
			{ author: "@you", body: "I approve myself." },
		]);
		// The post still goes through the supervisor, so the peer is woken as
		// the human's message — not silently dropped.
		expect(stub.prompts).toHaveLength(1);
	});

	test("a write claiming an @-namespaced peer as author is stored as the human", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@reviewer", body: "Also me." }),
		});

		expect(res.status).toBe(201);
		expect(await h.rooms.listMessages("#reviews", {})).toMatchObject([
			{ author: "@you", body: "Also me." },
		]);
	});

	test("coercion is universal: an unregistered identity is stored as the human", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		// No peer by this name exists, so an allow-list check would let it
		// through. Attribution is derived server-side, not filtered.
		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@ceo", body: "Ship it." }),
		});

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			message: { author: "@you", body: "Ship it." },
		});
		expect(await h.rooms.listMessages("#reviews", {})).toMatchObject([
			{ author: "@you", body: "Ship it." },
		]);
	});

	test("the human author is accepted", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/channels/%23reviews/messages", {
			method: "POST",
			body: JSON.stringify({ author: "@you", body: "Human here." }),
		});

		expect(res.status).toBe(201);
		expect(await h.rooms.listMessages("#reviews", {})).toMatchObject([
			{ author: "@you", body: "Human here." },
		]);
	});
});

// ── Live updates ─────────────────────────────────────────────────────────────

describe("websocket", () => {
	test("a connected websocket receives a message posted by an agent", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const frame = nextFrame(socket);
		// Posted through the supervisor, exactly as the control socket does for
		// an agent's `chat_send` — not through this API.
		await h.supervisor.post({
			room: "#reviews",
			author: "reviewer",
			body: "Review done.",
		});

		expect(await frame).toMatchObject({
			type: "message",
			message: {
				room: "#reviews",
				author: "reviewer",
				body: "Review done.",
			},
		});
	});

	test("a connected websocket receives a reaction", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Pick this up.",
		});

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const frame = nextFrame(socket);
		await h.rooms.react(posted.id, "reviewer", "👀");

		expect(await frame).toEqual({
			type: "reaction",
			room: "#reviews",
			messageId: posted.id,
			actor: "reviewer",
			emoji: "👀",
			reacted: true,
		});
	});

	test("a websocket does not replay the backlog on connect", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		await h.rooms.post({ room: "#reviews", author: "@you", body: "Old." });

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		// A client that had to filter history would show every old message as
		// new on every reconnect.
		await expect(nextFrame(socket, 120)).rejects.toThrow();
	});

	test("a websocket accepts the token as a query parameter", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");

		// A browser cannot set Authorization on a WebSocket handshake.
		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events?token=${TOKEN}`,
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const frame = nextFrame(socket);
		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Anyone?",
		});

		expect(await frame).toMatchObject({
			type: "message",
			message: { body: "Anyone?" },
		});
	});

	test("an unreact emits a reacted:false frame", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Pick this up.",
		});

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		const added = nextFrame(socket);
		await h.rooms.react(posted.id, "reviewer", "👀");
		// The add path carries the same boolean, so a client reads one field
		// rather than inferring direction from the frame's mere existence.
		expect(await added).toEqual({
			type: "reaction",
			room: "#reviews",
			messageId: posted.id,
			actor: "reviewer",
			emoji: "👀",
			reacted: true,
		});

		const removed = nextFrame(socket);
		await h.rooms.unreact(posted.id, "reviewer", "👀");
		expect(await removed).toEqual({
			type: "reaction",
			room: "#reviews",
			messageId: posted.id,
			actor: "reviewer",
			emoji: "👀",
			reacted: false,
		});
	});

	test("two reactions whose parts concatenate alike both emit removals", async () => {
		// Reaction identity is (message, actor, emoji), and both an actor and
		// an emoji are caller-supplied text. Joined with a separator these two
		// produce the same string, so a key built that way holds one entry for
		// two reactions and the second removal is silently never emitted.
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Ambiguous keys.",
		});
		await h.rooms.react(posted.id, "a:b", "c");
		await h.rooms.react(posted.id, "a", "b:c");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		await h.rooms.unreact(posted.id, "a:b", "c");
		await h.rooms.unreact(posted.id, "a", "b:c");
		await until(
			"both removals",
			() =>
				frames.filter(
					(frame) => frame.type === "reaction" && frame.reacted === false,
				).length === 2,
		);

		// Order within a tick is the store's read order, not a contract; the
		// claim is that both reactions are named, each with its own parts.
		expect(
			frames
				.filter((frame) => frame.type === "reaction")
				.map((frame) => `${frame.actor}|${frame.emoji}|${frame.reacted}`)
				.sort(),
		).toEqual(["a:b|c|false", "a|b:c|false"].sort());
	});

	test("a remove and re-add inside one tick collapses to no frame", async () => {
		// The poller reports state, not history: a reaction that is gone and
		// back before the next read never changed as far as any console can
		// observe, and emitting a removal there would make a chip flicker off
		// and on for a state transition that never happened.
		const h = await harness({ pollIntervalMs: 10_000 });
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Steady state.",
		});
		await h.rooms.react(posted.id, "reviewer", "👀");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		await h.rooms.unreact(posted.id, "reviewer", "👀");
		await h.rooms.react(posted.id, "reviewer", "👀");

		await expect(nextFrame(socket, 200)).rejects.toThrow();
	});

	test("a reaction removed while nothing was connected is not replayed", async () => {
		// `primeCursors` seeds the set from the store's current state, so its
		// first tick has nothing to diff against and must not manufacture a
		// removal for a key it never broadcast.
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Reacted before anyone looked.",
		});
		await h.rooms.react(posted.id, "reviewer", "👀");
		await h.rooms.unreact(posted.id, "reviewer", "👀");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);

		await expect(nextFrame(socket, 200)).rejects.toThrow();
	});

	test("a reaction ageing out of the window is not reported as a removal", async () => {
		// The reaction diff is bounded to the most recent `REACTION_WINDOW`
		// message ids. A key falling below that floor left the *read*, not the
		// store — treating it as a removal would have every long-lived console
		// erase old chips it can no longer see.
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");
		const old = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "The message that ages out.",
		});
		await h.rooms.react(old.id, "reviewer", "👀");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		// Push the reacted message more than REACTION_WINDOW ids into the past.
		for (let i = 0; i < REACTION_WINDOW + 10; i += 1) {
			await h.rooms.post({
				room: "#reviews",
				author: "reviewer",
				body: `Filler ${i}.`,
			});
		}
		await until(`a frame for Filler ${REACTION_WINDOW + 9}.`, () =>
			frames.some(
				(frame) =>
					frame.type === "message" &&
					frame.message.body === `Filler ${REACTION_WINDOW + 9}.`,
			),
		);

		// The reaction is untouched in the store; no frame may claim otherwise.
		expect(frames.filter((frame) => frame.type === "reaction")).toEqual([]);
	});
});

// ── Typed daemon frames (T-1604, ADR-015) ───────────────────────────────────

describe("typed frames", () => {
	test("a membership change emits a membership frame", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});
		expect(res.status).toBe(200);

		await until("a membership frame", () =>
			frames.some((frame) => frame.type === "membership"),
		);
		expect(frames.find((frame) => frame.type === "membership")).toEqual({
			type: "membership",
			agent: "reviewer",
			rooms: ["#ops", "#reviews"],
		});
	});

	test("creating an agent emits an agent frame", async () => {
		const h = await harness({ pollIntervalMs: 10 });

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "scribe",
				description: "Scribe peer for typed frame tests.",
				spawns: ["scout"],
				rooms: ["#notes"],
				body: "You are scribe.",
			}),
		});
		expect(res.status).toBe(201);

		await until("an agent frame", () =>
			frames.some((frame) => frame.type === "agent"),
		);
		// A created agent has no worker yet; it starts on the next daemon
		// start, and the frame says so rather than implying a live process.
		expect(frames.find((frame) => frame.type === "agent")).toEqual({
			type: "agent",
			agent: "scribe",
			state: "stopped",
		});
	});

	test("a channel created over HTTP emits a channel frame", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const res = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "#ops" }),
		});
		expect(res.status).toBe(201);

		await until("a channel frame", () =>
			frames.some((frame) => frame.type === "channel"),
		);
		expect(frames.find((frame) => frame.type === "channel")).toEqual({
			type: "channel",
			channel: { id: "#ops", kind: "channel", name: "#ops" },
		});
	});

	test("a definition edit emits a definition frame carrying rebuildRequired", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const res = await h.call("/api/agents/reviewer", {
			method: "PATCH",
			body: JSON.stringify({ description: "A policy edit." }),
		});
		expect(res.status).toBe(200);

		await until("a definition frame", () =>
			frames.some((frame) => frame.type === "definition"),
		);
		// Policy, not membership: the running worker keeps the old policy
		// until it rebuilds, and the frame carries that distinction.
		expect(frames.find((frame) => frame.type === "definition")).toEqual({
			type: "definition",
			agent: "reviewer",
			rebuildRequired: true,
		});
	});

	test("the default sink broadcasts with no wiring at all", async () => {
		// Zero-configuration is the point of the default: a daemon that never
		// calls `setPublishSink` still feeds every connected console, so the
		// supervisor's transitions are visible before anything is wired.
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		h.emit({ type: "schedule", agent: "reviewer", phase: "fired" });
		await until("a schedule frame", () =>
			frames.some((frame) => frame.type === "schedule"),
		);
		expect(frames.find((frame) => frame.type === "schedule")).toEqual({
			type: "schedule",
			agent: "reviewer",
			phase: "fired",
		});
	});

	test("a sink set after start redirects the supervisor's frames", async () => {
		// Ordering is the constraint the setter exists for: `main.ts` builds
		// the supervisor before `startConsoleApi`, so the sink cannot be a
		// start option — it has to be assignable on the returned handle, and
		// reassignable there without restarting the server.
		//
		// Redirection, not observation: the installed sink *replaces* the
		// default destination for supervisor emissions. An observer that only
		// ran alongside the broadcast would be load-bearing for nothing —
		// deleting the setter would break only its own test.
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const observed: ConsoleEvent[] = [];
		h.api.setPublishSink((event) => observed.push(event));
		h.emit({ type: "budget", account: "acct-1", state: "parked" });
		await until("the budget frame on the installed sink", () =>
			observed.some((event) => event.type === "budget"),
		);
		expect(observed).toEqual([
			{ type: "budget", account: "acct-1", state: "parked" },
		]);

		// An ordering barrier rather than a sleep: this route-driven frame is
		// published strictly after the redirected emission, so once the socket
		// has it, a budget frame that was going to arrive already would have.
		// Route emissions still broadcast — only the supervisor path moved.
		expect(
			(
				await h.call("/api/channels", {
					method: "POST",
					body: JSON.stringify({ id: "#ops" }),
				})
			).status,
		).toBe(201);
		await until("the channel frame on the socket", () =>
			frames.some((frame) => frame.type === "channel"),
		);
		expect(frames.some((frame) => frame.type === "budget")).toBe(false);
	});

	test("a sink that throws costs neither the transition nor the route", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.ensureRoom("#reviews");

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		h.api.setPublishSink(() => {
			throw new Error("sink is broken");
		});

		// The frame describes a transition that already committed, so a sink
		// failing after the fact must not propagate back into the supervisor
		// and fail a park that already parked.
		expect(() =>
			h.emit({ type: "budget", account: "acct-1", state: "parked" }),
		).not.toThrow();

		// Routes never touch the sink, so a broken one costs them nothing:
		// the create still returns 201 and the console still gets its frame.
		const res = await h.call("/api/channels", {
			method: "POST",
			body: JSON.stringify({ id: "#ops" }),
		});
		expect(res.status).toBe(201);
		await until("the channel frame despite the broken sink", () =>
			frames.some((frame) => frame.type === "channel"),
		);
		expect((await h.call("/api/channels")).status).toBe(200);
	});

	test("a budget bump emits a budget frame through the supervisor hook", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerMeteredPeer("spender", "acct-metered", 5);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		h.supervisor.bumpBudget("acct-metered", 25);
		await until("a budget frame", () =>
			frames.some((frame) => frame.type === "budget"),
		);
		expect(frames.find((frame) => frame.type === "budget")).toEqual({
			type: "budget",
			account: "acct-metered",
			state: "bumped",
			budgetUsd: 25,
		});
	});

	test("a resubscribe emits a membership frame after the cached set moves", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerPeer("reviewer", ["#reviews"]);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		await h.supervisor.resubscribe("reviewer");
		await until("a membership frame", () =>
			frames.some((frame) => frame.type === "membership"),
		);
		expect(frames.find((frame) => frame.type === "membership")).toEqual({
			type: "membership",
			agent: "reviewer",
			rooms: ["#reviews"],
		});
	});

	/**
	 * The production wiring, not the harness's.
	 *
	 * Every test above points the supervisor at the console by hand, which
	 * proves the seam and says nothing about whether the daemon uses it. This
	 * one boots a real daemon, connects to the console it serves, and spawns a
	 * peer over the control socket: the frame can only arrive if `main.ts`
	 * actually passed `emit` into the supervisor and resolved it to the
	 * console handle built afterwards.
	 */
	test("a real daemon's spawn reaches a connected console", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "oh-my-agent-console-boot-"));
		const projectDir = await mkdtemp(
			join(tmpdir(), "oh-my-agent-console-proj-"),
		);
		cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));

		const taskAgents = join(agentDir, "agents");
		await mkdir(taskAgents, { recursive: true });
		await writeFile(
			join(taskAgents, "scout.md"),
			'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
			"utf8",
		);
		// No peer definition on disk: boot starts everything it finds, so a
		// pre-existing one would already be running and the spawn below would
		// hit `agent_spawn`'s idempotent early return. The peer under test is
		// created after the console socket is open, so its spawn is a genuine
		// first transition.
		await mkdir(join(agentDir, "oh-my-agent", "agents"), { recursive: true });

		// `env: {}` keeps broker discovery off the real profile, exactly as
		// the other boot suites do.
		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir,
			workerFactory: async ({ peer }) => stubWorker(peer.name).worker,
		});
		cleanups.push(() => handle.close());

		const consoleUrl = handle.consoleUrl;
		if (consoleUrl === undefined) throw new Error("daemon served no console");
		const url = new URL(consoleUrl);
		const bootToken = url.searchParams.get("token") ?? "";
		expect(bootToken.length).toBeGreaterThan(0);

		const socket = new WebSocket(
			`ws://${url.host}/api/events?token=${encodeURIComponent(bootToken)}`,
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const token = await operatorToken(dirname(handle.socketPath));

		// Create, then spawn: creation only writes a definition, so the
		// running worker — and the frame it owes — comes from the spawn alone.
		const created = await controlCall(
			handle.socketPath,
			"agent_create",
			{
				name: "reviewer",
				description: "Reviewer peer for daemon wiring tests.",
				spawns: ["scout"],
				rooms: ["#reviews"],
				body: "You are reviewer.",
			},
			token,
			1,
		);
		expect(created).not.toHaveProperty("error");

		// Spawning over the control socket is a daemon transition, and nothing
		// in the console's own routes is involved: the only path from here to
		// this socket is the `emit` hook `main.ts` wires at construction.
		const spawned = await controlCall(
			handle.socketPath,
			"agent_spawn",
			{ name: "reviewer" },
			token,
			2,
		);
		expect(spawned).not.toHaveProperty("error");

		await until("an agent frame from a real daemon spawn", () =>
			frames.some(
				(frame) => frame.type === "agent" && frame.agent === "reviewer",
			),
		);
		expect(
			frames.find(
				(frame) => frame.type === "agent" && frame.agent === "reviewer",
			),
		).toEqual({ type: "agent", agent: "reviewer", state: "running" });
	}, 20_000);

	/**
	 * The other half of the production feed: a schedule's own transitions.
	 *
	 * `armed` and `fired` are the two the supervisor never sees — they come
	 * from the daemon's cron layer — so a console fed only through the
	 * supervisor would show a schedule that silently never reports anything.
	 */
	test("a real daemon's schedule arming reaches a connected console", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "oh-my-agent-console-cron-"));
		const projectDir = await mkdtemp(
			join(tmpdir(), "oh-my-agent-console-cronp-"),
		);
		cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));

		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "scout.md"),
			'---\nname: "scout"\ndescription: "Reads code."\n---\nYou are a scout.\n',
			"utf8",
		);
		const peerRoot = join(agentDir, "oh-my-agent", "agents");
		await mkdir(peerRoot, { recursive: true });
		await writeFile(
			join(peerRoot, "reviewer.md"),
			[
				"---",
				"name: reviewer",
				"description: Reviewer peer for schedule frame tests.",
				'spawns: ["scout"]',
				'rooms: ["#reviews"]',
				'schedules: [{"cron": "0 9 * * *", "prompt": "daily sweep", "room": "#reviews"}]',
				"---",
				"You are reviewer.",
				"",
			].join("\n"),
			"utf8",
		);

		const handle = await bootDaemon({
			env: {},
			agentDir,
			projectDir,
			workerFactory: async ({ peer }) => stubWorker(peer.name).worker,
		});
		cleanups.push(() => handle.close());

		const consoleUrl = handle.consoleUrl;
		if (consoleUrl === undefined) throw new Error("daemon served no console");
		const url = new URL(consoleUrl);
		const bootToken = url.searchParams.get("token") ?? "";

		const socket = new WebSocket(
			`ws://${url.host}/api/events?token=${encodeURIComponent(bootToken)}`,
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const token = await operatorToken(dirname(handle.socketPath));
		const id = "reviewer:schedule:0";
		// Boot armed this one before the console existed; disarm and re-arm so
		// the transition happens with a console connected.
		const disarmed = await controlCall(
			handle.socketPath,
			"schedules_arm",
			{ scheduleId: id, enabled: false },
			token,
			1,
		);
		expect(disarmed).not.toHaveProperty("error");
		const rearmed = await controlCall(
			handle.socketPath,
			"schedules_arm",
			{ scheduleId: id, enabled: true },
			token,
			2,
		);
		expect(rearmed).not.toHaveProperty("error");

		await until("a schedule frame from a real daemon", () =>
			frames.some((frame) => frame.type === "schedule"),
		);
		expect(frames.find((frame) => frame.type === "schedule")).toEqual({
			type: "schedule",
			agent: "reviewer",
			phase: "armed",
		});
	}, 20_000);
});

// ── Operations (T-1605) ─────────────────────────────────────────────────────

/**
 * The four operator capabilities, on the console's existing token gate.
 *
 * These routes add no second auth model and no second implementation: they
 * delegate to the same `operations.ts` the control socket drives, so a kill
 * from the browser and a kill from the CLI are the same kill. What is tested
 * here is the HTTP surface over that seam — the parsing, the status mapping,
 * and the honesty of the kill response about what actually died.
 */
describe("operations", () => {
	test("kill stops the worker and reports the subtree it really took", async () => {
		const h = await harness();
		const boss = await h.registerPeer("boss", ["#reviews"]);
		const report = await h.registerPeer("report", ["#reviews"], {
			parent: "boss",
		});
		const intern = await h.registerPeer("intern", ["#reviews"], {
			parent: "report",
		});

		const res = await h.call("/api/agents/boss/kill", {
			method: "POST",
			body: JSON.stringify({ keepChildren: false }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "boss",
			state: "stopped",
			keptChildren: false,
			cascaded: true,
		});
		expect(boss.state()).toBe("stopped");
		// The cascade is the daemon's, driven through the shared seam, and it
		// reaches the leaves rather than stopping one level down.
		expect(report.state()).toBe("stopped");
		expect(intern.state()).toBe("stopped");
		expect(h.kills).toEqual([{ name: "boss", keepChildren: false }]);
	});

	test("keepChildren spares the subtree and the response says so", async () => {
		const h = await harness();
		const boss = await h.registerPeer("boss", ["#reviews"]);
		const report = await h.registerPeer("report", ["#reviews"], {
			parent: "boss",
		});
		const intern = await h.registerPeer("intern", ["#reviews"], {
			parent: "report",
		});

		const res = await h.call("/api/agents/boss/kill", {
			method: "POST",
			body: JSON.stringify({ keepChildren: true }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "boss",
			state: "stopped",
			keptChildren: true,
			cascaded: false,
		});
		expect(boss.state()).toBe("stopped");
		// Sparing the children spares their own descendants with them: a
		// reparented child keeps the subtree hanging off it.
		expect(report.state()).toBe("running");
		expect(intern.state()).toBe("running");
	});

	test("with no tree wired, kill stops one worker and refuses to claim a cascade", async () => {
		const h = await harness();
		const boss = await h.registerPeer("boss", ["#reviews"]);
		const report = await h.registerPeer("report", ["#reviews"], {
			parent: "boss",
		});

		// A console over a context that wires no tree — the toolbelt's shape,
		// and `DaemonContext.killPeer`'s documented absence. The fallback
		// stops the named worker alone, and the response has to say so:
		// reporting `cascaded: true` here would tell an operator a subtree
		// died while its children kept running unsupervised.
		const unwired = await startConsoleApi({
			rooms: h.rooms,
			supervisor: h.supervisor,
			peers: h.peers,
			peerStore: h.peerStore,
			knownRooms: h.knownRooms,
			ensureRoom: h.ensureRoom,
			operations: createOperations({
				rooms: h.rooms,
				supervisor: h.supervisor,
				peers: h.peers,
				// No tree and no account layer: `killPeer` is the optional one
				// under test, and this context has no metered accounts, so a
				// bump reaching here is a wiring bug rather than a request to
				// answer quietly.
				bumpAccount: async (accountId) => {
					throw new Error(`No account layer is wired: ${accountId}`);
				},
			}),
			token: TOKEN,
		});
		cleanups.push(() => unwired.close());

		const res = await fetch(`${unwired.url}/api/agents/boss/kill`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ keepChildren: false }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "boss",
			state: "stopped",
			// No tree, so nothing below `boss` was ever reachable: the
			// children are kept because they could not be taken.
			keptChildren: true,
			cascaded: false,
		});
		expect(boss.state()).toBe("stopped");
		expect(report.state()).toBe("running");
	});

	test("a non-boolean keepChildren is refused, never read as absent", async () => {
		const h = await harness();
		const boss = await h.registerPeer("boss", ["#reviews"]);

		// The default is the cascade, so a value the daemon cannot read must
		// be refused: coercing `"false"` to "not true" turns "spare my
		// children" into "kill the subtree", which is unrecoverable.
		const res = await h.call("/api/agents/boss/kill", {
			method: "POST",
			body: JSON.stringify({ keepChildren: "false" }),
		});
		expect(res.status).toBe(400);
		expect(boss.state()).toBe("running");
		expect(h.kills).toEqual([]);
	});

	test("killing an unknown agent is a 404", async () => {
		const h = await harness();
		const res = await h.call("/api/agents/ghost/kill", {
			method: "POST",
			body: JSON.stringify({ keepChildren: false }),
		});
		expect(res.status).toBe(404);
	});

	test("inject prompts a running peer", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/inject", {
			method: "POST",
			body: JSON.stringify({ message: "Look at the build." }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "reviewer", queued: false });
		expect(peer.prompts).toEqual(["Look at the build."]);
	});

	test("inject on a parked peer queues into its room and delivers", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		await peer.park();

		const res = await h.call("/api/agents/reviewer/inject", {
			method: "POST",
			body: JSON.stringify({ message: "Queued for later." }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "reviewer", queued: true });
		// The message is in the room the peer subscribes to, posted as the
		// human — the console never forges an agent author.
		const posted = await h.rooms.listMessages("#reviews", {});
		expect(posted.map((message) => message.body)).toContain(
			"Queued for later.",
		);
		expect(posted.at(-1)?.author).toBe("@you");
	});

	test("inject on a parked peer with no rooms is a 400, not a 500", async () => {
		const h = await harness();
		const peer = await h.registerPeer("hermit", []);
		await peer.park();

		// There is nowhere to queue the message, which is a fact about the
		// request the caller made and not an internal fault.
		const res = await h.call("/api/agents/hermit/inject", {
			method: "POST",
			body: JSON.stringify({ message: "Nowhere to put this." }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("no room");
	});

	test("inject requires a message", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		const res = await h.call("/api/agents/reviewer/inject", {
			method: "POST",
			body: JSON.stringify({ message: "   " }),
		});
		expect(res.status).toBe(400);
	});

	test("the logs route tails the worker's stderr, newest last", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		peer.stderr.push("first line", "second line", "third line");

		const res = await h.call("/api/agents/reviewer/logs");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "reviewer",
			lines: ["first line", "second line", "third line"],
		});
	});

	test("lines bounds the tail to the most recent lines", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		peer.stderr.push("one", "two", "three", "four");

		const res = await h.call("/api/agents/reviewer/logs?lines=2");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "reviewer",
			lines: ["three", "four"],
		});
	});

	test("a malformed lines is refused rather than silently defaulted", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		const res = await h.call("/api/agents/reviewer/logs?lines=all");
		expect(res.status).toBe(400);
	});

	test("logs for an unknown agent is a 404", async () => {
		const h = await harness();
		const res = await h.call("/api/agents/ghost/logs");
		expect(res.status).toBe(404);
	});

	test("bump raises the ceiling and reports what it resumed", async () => {
		const h = await harness();
		const spender = await h.registerMeteredPeer("spender", "acct-metered", 5);

		// Nothing was parked, so nothing was resumed. That empty list is the
		// contract: `resumed` names peers the bump actually restarted, and
		// listing every running peer on the account instead would tell an
		// operator the bump revived work that was never stopped. A real
		// quota park is the supervisor's own transition (tests/supervisor
		// covers it) and cannot be staged from here by moving worker state,
		// which leaves the account registry untouched.
		const res = await h.call("/api/accounts/acct-metered/bump", {
			method: "POST",
			body: JSON.stringify({ budgetUsd: 25 }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			account: "acct-metered",
			budgetUsd: 25,
			resumed: [],
		});
		expect(spender.state()).toBe("running");
		expect(h.bumps).toEqual([{ accountId: "acct-metered", budgetUsd: 25 }]);
	});

	test("a bump emits the budget frame carrying the new ceiling", async () => {
		const h = await harness({ pollIntervalMs: 10 });
		await h.registerMeteredPeer("spender", "acct-metered", 5);

		const socket = new WebSocket(
			`${h.api.url.replace("http://", "ws://")}/api/events`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		cleanups.push(async () => socket.close());
		await opened(socket);
		const frames = collectFrames(socket);

		const res = await h.call("/api/accounts/acct-metered/bump", {
			method: "POST",
			body: JSON.stringify({ budgetUsd: 42 }),
		});
		expect(res.status).toBe(200);

		// The console repaints its budget state from this frame rather than
		// from a poll, so the new ceiling has to ride on it.
		await until("a budget frame", () =>
			frames.some((frame) => frame.type === "budget"),
		);
		expect(frames.find((frame) => frame.type === "budget")).toEqual({
			type: "budget",
			account: "acct-metered",
			state: "bumped",
			budgetUsd: 42,
		});
	});

	test("a non-numeric budgetUsd is refused", async () => {
		const h = await harness();
		await h.registerMeteredPeer("spender", "acct-metered", 5);
		const res = await h.call("/api/accounts/acct-metered/bump", {
			method: "POST",
			body: JSON.stringify({ budgetUsd: "lots" }),
		});
		expect(res.status).toBe(400);
		expect(h.bumps).toEqual([]);
	});

	test("the ops routes are behind the same token gate as everything else", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		for (const [path, init] of [
			["/api/agents/reviewer/kill", { method: "POST", body: "{}" }],
			[
				"/api/agents/reviewer/inject",
				{ method: "POST", body: JSON.stringify({ message: "hi" }) },
			],
			["/api/agents/reviewer/logs", {}],
			[
				"/api/accounts/acct-1/bump",
				{ method: "POST", body: JSON.stringify({ budgetUsd: 1 }) },
			],
		] as [string, RequestInit][]) {
			const res = await h.call(path, { ...init, token: null });
			expect(res.status).toBe(401);
		}
		// Refused means nothing ran, not "ran unauthenticated".
		expect(peer.state()).toBe("running");
		expect(peer.prompts).toEqual([]);
	});
});

// ── Reactions ────────────────────────────────────────────────────────────────

describe("reactions", () => {
	test("toggling a reaction on adds it, and toggling again removes it", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "React to me.",
		});

		const on = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});
		expect(on.status).toBe(200);
		expect(await on.json()).toMatchObject({ reacted: true });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "@you", emoji: "👀" },
		]);

		const off = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});
		expect(off.status).toBe(200);
		expect(await off.json()).toMatchObject({ reacted: false });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual(
			[],
		);
	});

	test("a toggle leaves another actor's identical reaction alone", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "reviewer",
			body: "Two reactors.",
		});
		await h.rooms.react(posted.id, "reviewer", "👀");

		await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});
		await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});

		// Unreact is keyed by (message, actor, emoji): deleting by emoji alone
		// would take the agent's status reaction with it.
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "reviewer", emoji: "👀" },
		]);
	});

	test("a toggle naming a registered peer as actor reacts as the human", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Whose status is this?",
		});

		const res = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ actor: "reviewer", emoji: "👀" }),
		});

		// Reactions carry agent status (ADR-009); a forgeable actor would let
		// the console claim an agent picked work up, so the actor is derived
		// server-side rather than taken from the body (ADR-014).
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ actor: "@you", reacted: true });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "@you", emoji: "👀" },
		]);
	});

	test("reaction coercion is universal: an unregistered actor becomes the human", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "Nobody by that name.",
		});

		const res = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ actor: "@ceo", emoji: "👀" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ actor: "@you" });
		expect((await h.rooms.listMessages("#reviews", {}))[0]?.reactions).toEqual([
			{ actor: "@you", emoji: "👀" },
		]);
	});

	test("a toggle on an unknown message is a 404", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");

		const res = await h.call("/api/messages/9999/reactions/toggle", {
			method: "POST",
			body: JSON.stringify({ emoji: "👀" }),
		});

		expect(res.status).toBe(404);
	});

	test("an empty emoji is rejected", async () => {
		const h = await harness();
		await h.ensureRoom("#reviews");
		const posted = await h.rooms.post({
			room: "#reviews",
			author: "@you",
			body: "No emoji.",
		});

		const res = await h.call(`/api/messages/${posted.id}/reactions/toggle`, {
			method: "POST",
			body: JSON.stringify({ emoji: "  " }),
		});

		expect(res.status).toBe(400);
	});
});

// ── Creating agents ──────────────────────────────────────────────────────────

describe("agent creation", () => {
	test("a created agent lands as a definition file the next boot loads", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "researcher",
				description: "Researches things.",
				spawns: ["scout"],
				rooms: ["#reviews"],
				body: "You are the researcher.",
			}),
		});

		expect(res.status).toBe(201);
		const created = (await res.json()) as {
			agent: { name: string; path: string; rooms: string[] };
		};
		expect(created.agent.name).toBe("researcher");
		expect(created.agent.path).toBe(join(h.roots.project, "researcher.md"));

		// A cold peer store — what the daemon builds on the next start — must
		// see it, or the UI has become a second source of truth.
		const listing = await h.reload();
		expect(listing.errors).toEqual([]);
		const definition = listing.definitions.find((d) => d.name === "researcher");
		expect(definition).toBeDefined();
		expect(definition?.rooms).toEqual(["#reviews"]);
		expect(definition?.body.trim()).toBe("You are the researcher.");
	});

	test("an invalid definition is refused with the parser's own error and writes nothing", async () => {
		const h = await harness();

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "broken",
				description: "Rooms without a prefix.",
				spawns: ["scout"],
				rooms: ["reviews"],
				body: "You are broken.",
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("invalid_definition");
		// The parser's own words, not a paraphrase: the operator has to be able
		// to act on the same message the daemon would later print.
		expect(body.error.message).toContain('rooms entries must start with "#"');

		await expect(
			readFile(join(h.roots.project, "broken.md"), "utf8"),
		).rejects.toThrow();
		expect((await h.reload()).definitions.map((d) => d.name)).not.toContain(
			"broken",
		);
	});

	test("a created agent's rooms exist and are listed as channels", async () => {
		const h = await harness();

		await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "researcher",
				description: "Researches things.",
				spawns: ["scout"],
				rooms: ["#research"],
				body: "You are the researcher.",
			}),
		});

		const listed = await h.call("/api/channels");
		const body = (await listed.json()) as { channels: RoomInfo[] };
		expect(body.channels.map((c) => c.id)).toContain("#research");
	});

	test("creating an agent that already exists is refused", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				name: "reviewer",
				description: "A second reviewer.",
				spawns: ["scout"],
				body: "You are a different reviewer.",
			}),
		});

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("conflict");
		// The original definition is untouched.
		const listing = await h.reload();
		expect(
			listing.definitions.find((d) => d.name === "reviewer")?.description,
		).toContain("console management tests");
	});
});

// ── Membership ───────────────────────────────────────────────────────────────

describe("membership", () => {
	test("adding a running agent to a channel wakes it on the very next post", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { rooms: string[] }).toMatchObject({
			rooms: ["#ops", "#reviews"],
		});

		// Through the supervisor, which is the only path that proves the live
		// peer's cached room set was updated; RoomStore.post() would pass even
		// with a SQLite-only write.
		await h.supervisor.post({
			room: "#ops",
			author: "@you",
			body: "Ops needs you.",
		});

		expect(peer.prompts.join("\n")).toContain("Ops needs you.");
	});

	test("removing a running agent stops delivery without disturbing other members", async () => {
		const h = await harness();
		const leaving = await h.registerPeer("reviewer", ["#reviews"]);
		const staying = await h.registerPeer("researcher", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/rooms/%23reviews", {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { rooms: string[] }).toMatchObject({
			rooms: [],
		});

		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Still listening?",
		});

		expect(leaving.prompts.join("\n")).not.toContain("Still listening?");
		expect(staying.prompts.join("\n")).toContain("Still listening?");
	});

	test("a removed room's backlog is not delivered when the peer wakes for another reason", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews", "#ops"]);

		await h.call("/api/agents/reviewer/rooms/%23reviews", {
			method: "DELETE",
		});

		await h.supervisor.post({
			room: "#reviews",
			author: "@you",
			body: "Left channel traffic.",
		});
		// Woken legitimately by a room it is still in. The durable subscription
		// row survives removal (RoomStore has no unsubscribe; T-402 owns it),
		// so a delivery that trusted the database would smuggle the left
		// channel's backlog into this turn.
		await h.supervisor.post({
			room: "#ops",
			author: "@you",
			body: "Ops traffic.",
		});

		expect(peer.prompts.join("\n")).toContain("Ops traffic.");
		expect(peer.prompts.join("\n")).not.toContain("Left channel traffic.");
	});

	test("a membership change is written to the definition as well as the subscription", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});

		// Durable on both sides: the next daemon start reads the file, and a
		// change that lived only in SQLite would be lost by it.
		const listing = await h.reload();
		expect(listing.errors).toEqual([]);
		expect(
			listing.definitions.find((d) => d.name === "reviewer")?.rooms,
		).toEqual(["#ops", "#reviews"]);
	});

	test("membership alone takes effect live and needs no rebuild", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);
		await h.ensureRoom("#ops");

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});
		expect((await res.json()) as { rebuildRequired: boolean }).toMatchObject({
			rebuildRequired: false,
		});

		await h.supervisor.post({
			room: "#ops",
			author: "@you",
			body: "No restart needed.",
		});

		// The staleness check re-read the file the console just rewrote and
		// found the same policy, so the live session survived.
		expect(h.respawns).toEqual([]);
		expect(peer.state()).toBe("running");
		expect(peer.prompts.join("\n")).toContain("No restart needed.");
	});

	test("adding an agent to an unknown channel creates it", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#brand-new" }),
		});
		expect(res.status).toBe(200);

		await h.supervisor.post({
			room: "#brand-new",
			author: "@you",
			body: "Fresh channel.",
		});
		expect(peer.prompts.join("\n")).toContain("Fresh channel.");
	});

	test("membership on an unregistered agent is a 404", async () => {
		const h = await harness();
		await h.ensureRoom("#ops");

		const res = await h.call("/api/agents/ghost/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "#ops" }),
		});

		expect(res.status).toBe(404);
	});

	test("an invalid room id is refused and changes nothing", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer/rooms", {
			method: "POST",
			body: JSON.stringify({ room: "ops" }),
		});

		expect(res.status).toBe(400);
		expect(
			(await h.reload()).definitions.find((d) => d.name === "reviewer")?.rooms,
		).toEqual(["#reviews"]);
		expect(peer.state()).toBe("running");
	});
});

// ── Definition edits ─────────────────────────────────────────────────────────

describe("definition edits", () => {
	test("a policy edit is reported as needing a rebuild and is not applied live", async () => {
		const h = await harness();
		const peer = await h.registerPeer("reviewer", ["#reviews"]);

		const res = await h.call("/api/agents/reviewer", {
			method: "PATCH",
			body: JSON.stringify({ body: "You are a much stricter reviewer." }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()) as { rebuildRequired: boolean }).toMatchObject({
			rebuildRequired: true,
		});
		// §10.3: no file mutates under a live worker and no hot reload happens
		// here; the rebuild is the supervisor's, on the next delivered turn.
		expect(h.respawns).toEqual([]);
		expect(peer.state()).toBe("running");

		const listing = await h.reload();
		expect(
			listing.definitions.find((d) => d.name === "reviewer")?.body.trim(),
		).toBe("You are a much stricter reviewer.");
	});

	test("an edit the parser refuses leaves the definition on disk untouched", async () => {
		const h = await harness();
		await h.registerPeer("reviewer", ["#reviews"]);
		const before = await readFile(join(h.roots.project, "reviewer.md"), "utf8");

		const res = await h.call("/api/agents/reviewer", {
			method: "PATCH",
			body: JSON.stringify({ body: "   " }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_definition");
		expect(await readFile(join(h.roots.project, "reviewer.md"), "utf8")).toBe(
			before,
		);
	});
});
