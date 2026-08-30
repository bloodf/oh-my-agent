#!/usr/bin/env bun
/**
 * Purpose: The daemon's composition root (§4.1). `omp-agent daemon` boots every
 * subsystem in dependency order, registers the peers the store lists, serves the
 * T-507 control socket, and keeps running after the launching terminal closes.
 * Shutdown reverses that order so a stop never strands a parked watcher or a
 * half-stopped worker.
 *
 * Public API: `bootDaemon(options): Promise<DaemonHandle>` and, when run as a
 * program, the `daemon` CLI verb that re-spawns itself detached.
 *
 * Upstream deps: `./boot` (broker hosting), `./credential-gateway`,
 * `../rooms/store`, `./scheduler`, `./supervisor`, `./peer-store`, `./socket`,
 * and — through the default worker factory — `./materializer` plus
 * `../worker/lifecycle`.
 *
 * Downstream consumers: the CLI entry point below, plus T-508's persistence and
 * T-504's TUI, which reach this process only through the socket.
 *
 * Failure modes: a live pidfile for the same agent dir refuses the boot rather
 * than letting two daemons share one vault, one socket, and one room database. A
 * stale pidfile or socket file left by a crash is replaced. Anything already
 * started when a later step fails is closed before the error propagates, so a
 * failed boot leaves no orphaned broker, gateway, or database handle.
 *
 * Performance: one broker, one gateway, one SQLite handle, and one child process
 * per running peer.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, postmortem } from "@oh-my-pi/pi-utils";

import { RoomStore } from "../rooms/store";
import type {
	Automation,
	PeerDefinition,
	Schedule,
} from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";
import type {
	AgentSpawnResult,
	RoomInfo,
	ScheduleInfo,
} from "../shared/protocol";
import type { WorkerHandle } from "../worker/lifecycle";
import { startInProcessWorker, startWorker } from "../worker/lifecycle";
import { resolveBrokerHosting } from "./boot";
import type { ConsoleApi } from "./console-api";
import { startConsoleApi } from "./console-api";
import { startCredentialGateway } from "./credential-gateway";
import type { RunTrigger } from "./db";
import { DaemonDb } from "./db";
import { materializeWorker } from "./materializer";
import type { PeerDefinitionFields } from "./peer-store";
import { createPeerStore, resolvePeerStoreRoots } from "./peer-store";
import { nextCronTime, Scheduler } from "./scheduler";
import type {
	ControlIdentity,
	DaemonContext,
	PeerRecord,
	ScheduleRecord,
} from "./socket";
import { HUMAN_AUTHOR, InvalidParamsError, startControlSocket } from "./socket";
import type { SupervisedWorker } from "./supervisor";
import { Supervisor } from "./supervisor";

/** Everything the daemon owns lives under this directory in the agent dir. */
const STATE_DIR = "oh-my-agent";

/** Set on the detached child so it runs the daemon instead of re-spawning. */
const DETACHED_ENV = "OMA_DETACHED";

export interface WorkerFactoryOptions {
	peer: PeerDefinition;
	/** Project directory the worker edits. Not its synthetic root. */
	cwd: string;
	/**
	 * The daemon's own OMP agent dir. Ignored by the RPC path (which
	 * materializes its own agent dir under `rootDir`); consumed by the
	 * in-process path, which has no materialized tree of its own.
	 */
	agentDir: string;
	/** Root for this worker's materialized synthetic user tree. */
	rootDir: string;
	/** Names the worker's deny-list is built against. */
	discoveredAgentNames: string[];
	/** Scoped per-worker credential endpoint; never the admin token. */
	inferenceGateway: { url: string; token: string };
	/** Raw markdown for each agent the peer names in `spawns:`. */
	sourceSpawnAgents: Record<string, string>;
	/** Absolute path of the daemon control socket, exported to the worker env. */
	socketPath: string;
	/** Bearer credential for this worker's control-socket identity. */
	controlToken: string;
	/**
	 * True when the daemon was booted with `inProcessWorkers: true`. The
	 * default factory uses this to route the call to the in-process OMP
	 * session backend instead of the materialized RPC subprocess path.
	 * Custom factories (tests, vendored installs) receive the same value
	 * and branch on it themselves.
	 */
	inProcess: boolean;
}

/**
 * How a peer definition becomes a running worker. Injected so tests can
 * exercise composition without spawning an RPC child per peer.
 */
export type WorkerFactory = (
	options: WorkerFactoryOptions,
) => Promise<SupervisedWorker>;

export interface BootDaemonOptions {
	/** Consulted for broker discovery. Defaults to the real environment. */
	env?: Record<string, string | undefined>;
	/** Active agent dir. Defaults to OMP's, honoring PI_CODING_AGENT_DIR. */
	agentDir?: string;
	/** Project whose private peer store is loaded. Defaults to the cwd. */
	projectDir?: string;
	workerFactory?: WorkerFactory;
	now?: () => number;
	logger?: (message: string) => void;
	/**
	 * Upstream broker transport, injected so a test can serve fixture snapshot
	 * and usage payloads. Shared with the credential gateway, which already
	 * exposes this seam. Defaults to the global `fetch`.
	 */
	fetchUpstream?: (input: string, init?: RequestInit) => Promise<Response>;
	/** How often the usage loop polls, in ms. Defaults to 60s. */
	usagePollMs?: number;
	/**
	 * Handed the usage poller once armed, so a test can step it deterministically
	 * instead of waiting on the interval. Not used in production.
	 */
	onUsagePoller?: (poller: { pollOnce(): Promise<void> }) => void;
	/**
	 * Called once with the console URL, or with `undefined` when no console was
	 * mounted. The detached CLI relays this to the launcher's terminal, which
	 * is the only place an operator can actually read it.
	 */
	announce?: (url: string | undefined) => void;
	/**
	 * Run every peer as an in-process OMP session (T-1006) instead of the
	 * default materialized RPC subprocess. Default `false`: RPC stays the
	 * default backend. An in-process worker shares the daemon's own process
	 * — no materialized synthetic root, no per-worker credential-gate token,
	 * no shell-level sandbox — see `startInProcessWorker` in
	 * `src/worker/lifecycle.ts` for the full boundary this trades away.
	 */
	inProcessWorkers?: boolean;
}

export interface DaemonHandle {
	socketPath: string;
	pidPath: string;
	/** Where the console is served, token included; absent when disabled. */
	consoleUrl?: string;
	close(): Promise<void>;
}

/**
 * The account whose quota governs a peer. Billing is an account property, not
 * an agent one (§9.4), and a peer's account is the provider behind its model.
 */
function accountIdFor(peer: PeerDefinition): string {
	const selector = Array.isArray(peer.model) ? peer.model[0] : peer.model;
	if (typeof selector !== "string" || selector.trim().length === 0) {
		return "default";
	}
	const separator = selector.indexOf("/");
	return separator > 0 ? selector.slice(0, separator) : selector;
}

/**
 * Where a peer definition was parsed from.
 *
 * `parsePeerDefinition` spreads OMP's own `AgentDefinition`, which carries
 * `filePath`, but `PeerDefinition` omits that field from its declared shape.
 * The value is there at runtime and is exactly what the persisted registry has
 * to record, so it is narrowed back out here rather than by widening the shared
 * type, which T-501 owns.
 */
function definitionPathFor(peer: PeerDefinition): string {
	if ("filePath" in peer && typeof peer.filePath === "string") {
		return peer.filePath;
	}
	return "";
}

/**
 * Claim the single-instance pidfile, or refuse. A pidfile naming a live process
 * is a running daemon; one naming a dead process is crash debris and is
 * replaced, because refusing forever after a crash would need manual cleanup.
 */
async function claimPidfile(pidPath: string): Promise<void> {
	try {
		const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
		if (Number.isInteger(pid) && pid > 0) {
			let alive = true;
			try {
				// Signal 0 checks for existence without delivering anything.
				process.kill(pid, 0);
			} catch (error) {
				// EPERM means it exists but belongs to someone else: still alive.
				alive = (error as NodeJS.ErrnoException).code === "EPERM";
			}
			if (alive) {
				throw new Error(
					`oh-my-agent daemon is already running for this profile (pid ${pid}, ${pidPath})`,
				);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeFile(pidPath, String(process.pid), "utf8");
}

/** Where the operator token lives, and the only mode it may have. */
const TOKEN_FILE = "console-token";
const TOKEN_MODE = 0o600;

/**
 * Load the operator token, or mint one.
 *
 * A stored token is reused so the URL an operator bookmarked keeps working
 * across restarts; deleting the file is how you rotate. A file with looser
 * permissions than 0600 fails the boot rather than being quietly replaced:
 * regenerating would revoke the URL the operator is holding without saying so,
 * and leaving it would keep serving a secret every local process can read.
 */
async function loadConsoleToken(stateDir: string): Promise<string> {
	const path = join(stateDir, TOKEN_FILE);
	try {
		const stats = await stat(path);
		const mode = stats.mode & 0o777;
		if (mode !== TOKEN_MODE) {
			throw new Error(
				`${path} has mode ${mode.toString(8)}, not 0600: any local process can read the console token. ` +
					`Run 'chmod 600 ${path}' to keep this token, or delete the file to rotate it.`,
			);
		}
		const token = (await readFile(path, "utf8")).trim();
		if (token.length > 0) return token;
		// An empty file is crash debris, not a token: nothing was revoked by
		// replacing it, because it never gated anything.
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// 32 bytes of CSPRNG, base64url so it survives a URL without escaping.
	const token = randomBytes(32).toString("base64url");
	// `mode` on write only applies to a file being created, so an existing
	// empty one is removed first rather than left with whatever mode it had.
	await rm(path, { force: true });
	await writeFile(path, token, { encoding: "utf8", mode: TOKEN_MODE });
	// umask can mask bits off the create mode; set them explicitly.
	await chmod(path, TOKEN_MODE);
	return token;
}

/**
 * The real worker path: materialize a synthetic root, then launch the child.
 *
 * T-1006 selects the in-process OMP session only when `options.inProcess` is
 * true. RPC is still the default. In-process deliberately skips materializer
 * setup: no synthetic HOME/XDG root, no worker gateway/control token, no
 * shell-level sandbox; its auth/tool boundary is the daemon's own process.
 */
const defaultWorkerFactory: WorkerFactory = async (options) => {
	if (options.inProcess) {
		const peerModel = options.peer.model;
		const modelPattern = Array.isArray(peerModel)
			? peerModel.join(",")
			: peerModel;
		const peerSpawns = options.peer.spawns;
		const spawns = peerSpawns === "*" ? "*" : peerSpawns.join(",");
		return await startInProcessWorker({
			peer: options.peer,
			cwd: options.cwd,
			agentDir: options.agentDir,
			fingerprint: fingerprintPeerDefinition(options.peer),
			appendSystemPrompt: options.peer.body,
			modelPattern,
			spawns,
			agentId: options.peer.name,
			// No cross-call SessionManager here: the daemon does not own a
			// shared one, so each `startInProcessWorker` builds its own.
			// Park/resume will discard it and the SDK re-initializes one
			// fresh on resume. Persistence is whatever OMP writes to the
			// per-agent storage rooted at `agentDir`.
		});
	}

	const layout = await materializeWorker({
		rootDir: options.rootDir,
		parsedPeer: options.peer,
		discoveredAgentNames: options.discoveredAgentNames,
		inferenceGateway: options.inferenceGateway,
		// A peer's `spawns:` closure must be materialized alongside it, or
		// `materializeWorker` refuses to build the root at all.
		sourceSpawnAgents: options.sourceSpawnAgents,
	});
	// Point the toolbelt at the daemon explicitly; the path heuristic in
	// src/worker/toolbelt.ts remains the fallback for non-standard layouts.
	layout.env.OH_MY_AGENT_SOCKET = options.socketPath;
	layout.env.OH_MY_AGENT_CONTROL_TOKEN = options.controlToken;
	return await startWorker({ peer: options.peer, layout, cwd: options.cwd });
};

export async function bootDaemon(
	options: BootDaemonOptions = {},
): Promise<DaemonHandle> {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const projectDir = options.projectDir ?? process.cwd();
	const workerFactory = options.workerFactory ?? defaultWorkerFactory;
	const inProcessWorkers = options.inProcessWorkers ?? false;
	const now = options.now ?? Date.now;
	const log = options.logger ?? (() => {});

	const stateDir = join(agentDir, STATE_DIR);
	const pidPath = join(stateDir, "daemon.pid");
	const socketPath = join(stateDir, "daemon.sock");

	await mkdir(stateDir, { recursive: true });
	await claimPidfile(pidPath);
	// A crash can leave the socket file behind; `Bun.serve` will not bind over it.
	await rm(socketPath, { force: true });

	// Anything started below must be closed if a later step throws, or a failed
	// boot leaves an orphaned broker and a locked database behind.
	const started: (() => Promise<void>)[] = [() => rm(pidPath, { force: true })];

	try {
		const hosting = await resolveBrokerHosting({ agentDir, env });
		started.push(() => hosting.close());

		const fetchUpstream = options.fetchUpstream ?? fetch;
		const gateway = await startCredentialGateway({
			upstreamUrl: hosting.url,
			adminToken: hosting.adminToken,
			fetchUpstream,
		});
		started.push(() => gateway.close());

		const rooms = await RoomStore.open(join(stateDir, "rooms.db"));
		started.push(() => rooms.close());

		const db = await DaemonDb.open(join(stateDir, "daemon.db"));
		started.push(async () => db.close());

		// Flipped off just before the handle closes: a turn released after
		// shutdown has judged it must not reach a closed database.
		let recording = true;

		// The daemon's clock, not the scheduler's own: `armCron` computes a
		// schedule's next fire from `now`, and a scheduler timing its timers off
		// a different clock would arm them against a deadline nobody else agrees
		// with.
		const scheduler = new Scheduler({
			now,
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (handle) => {
				// The handle is whatever `setTimer` just returned — a Bun timer —
				// but `TimerHandle` is declared `unknown`, so the compiler cannot
				// carry that through and there is nothing to check at runtime.
				const timer = handle as Timer;
				clearTimeout(timer);
			},
			onError: (error, jobId) => log(`schedule ${jobId}: ${String(error)}`),
		});
		scheduler.start();
		started.push(async () => scheduler.stop());

		const store = createPeerStore(
			resolvePeerStoreRoots({ agentDir, projectDir }),
		);

		const peers = new Map<string, PeerRecord>();
		const knownRooms = new Map<string, RoomInfo>();
		const schedules = new Map<string, ScheduleRecord>();
		const definitions = new Map<string, PeerDefinition>();
		const operatorToken = await loadConsoleToken(stateDir);
		const identities = new Map<string, ControlIdentity>([
			[operatorToken, { kind: "operator" }],
		]);
		const workerTokens = new Map<string, string>();
		const mintControlToken = (): string =>
			randomBytes(32).toString("base64url");
		const activateControlToken = (peerName: string, token: string): void => {
			const previous = workerTokens.get(peerName);
			workerTokens.set(peerName, token);
			identities.set(token, { kind: "worker", peerName });
			if (previous !== undefined) identities.delete(previous);
		};
		const revokeControlToken = (peerName: string): void => {
			const token = workerTokens.get(peerName);
			if (token === undefined) return;
			workerTokens.delete(peerName);
			identities.delete(token);
		};

		/** Update runtime-only registry fields without disturbing persisted identity. */
		const markAgentRuntime = (
			name: string,
			status: "running" | "parked" | "stopped",
			workerPid: number | null,
		): void => {
			const row = db.listAgents().find((agent) => agent.name === name);
			if (row) db.upsertAgent({ ...row, status, workerPid });
		};

		const supervisor = new Supervisor({
			rooms,
			scheduler,
			now,
			onError: (error, peerName) => log(`peer ${peerName}: ${String(error)}`),
			// T-505: definitions re-read per delivery; a fingerprint mismatch
			// rebuilds through this seam rather than reusing stale policy.
			peers: store,
			respawn: async ({ peerName, definition, previousFingerprint }) => {
				log(
					`rebuilding ${peerName}: definition changed (was ${previousFingerprint.slice(0, 12)}…)`,
				);
				const controlToken = mintControlToken();
				const fresh = recordRuns(
					await workerFactory({
						peer: definition,
						cwd: projectDir,
						agentDir,
						rootDir: join(stateDir, "workers", peerName),
						discoveredAgentNames,
						inferenceGateway: {
							url: gateway.url,
							token: gateway.issueWorkerToken({
								workerId: peerName,
								credentialIds: credentialIdsFor(
									peers.get(peerName)?.accountId ?? accountIdFor(definition),
								),
							}).token,
						},
						sourceSpawnAgents: await spawnSourcesFor(definition),
						socketPath,
						controlToken,
						inProcess: inProcessWorkers,
					}),
				);
				activateControlToken(peerName, controlToken);
				// The supervisor swaps its own Peer record on return; the daemon's
				// parallel map backs status/stop, so it must point at the live
				// worker too.
				const record = peers.get(peerName);
				if (record) peers.set(peerName, { ...record, worker: fresh });
				markAgentRuntime(peerName, fresh.state, fresh.pid ?? null);
				return fresh;
			},
		});

		/**
		 * Why the turn being delivered is happening. The supervisor decides who
		 * to prompt, so the trigger is known only where that decision is made —
		 * the cron handler, or a socket post. Carrying it through async context
		 * is what lets the run recorder name it without the supervisor growing a
		 * parameter for the daemon's bookkeeping.
		 */
		const triggerContext = new AsyncLocalStorage<RunTrigger>();

		const ensureRoom = async (id: string): Promise<void> => {
			if (knownRooms.has(id)) return;
			const kind = id.startsWith("@") ? "dm" : "channel";
			await rooms.createRoom({ id, kind });
			knownRooms.set(id, { id, kind, name: id });
		};

		const listing = await store.list();
		for (const failed of listing.errors) {
			// A malformed definition must not take the whole daemon down with it.
			log(`peer definition ignored: ${failed.error.message}`);
		}
		for (const definition of listing.definitions) {
			definitions.set(definition.name, definition);
		}
		const discoveredAgentNames = [...definitions.keys()];

		/**
		 * The account→credential binding, read once from the broker snapshot.
		 *
		 * An account id is the model's provider key (`accountIdFor`), and the
		 * broker enumerates credentials no finer than provider, so a worker on an
		 * account is bound to every credential of that provider — the level that
		 * exists. Read at boot: credentials added mid-run are picked up on the next
		 * restart. A snapshot that cannot be read leaves the map empty rather than
		 * failing the boot, so a broker blip does not strand the daemon; the cost
		 * is a worker that sees nothing until the next boot reads a good snapshot.
		 *
		 * ponytail: provider-granularity binding; upgrade path is a broker that
		 * enumerates per-account credential ids, at which point this filters on the
		 * snapshot's `credential.accountId` instead of `provider`.
		 */
		const providerCredentials = new Map<string, number[]>();
		try {
			const res = await fetchUpstream(`${hosting.url}/v1/snapshot`, {
				headers: { Authorization: `Bearer ${hosting.adminToken}` },
			});
			if (res.ok) {
				const body = (await res.json()) as {
					credentials?: { id: number; provider: string }[];
				};
				for (const entry of body.credentials ?? []) {
					const ids = providerCredentials.get(entry.provider) ?? [];
					ids.push(entry.id);
					providerCredentials.set(entry.provider, ids);
				}
			} else {
				log(`usage binding: snapshot read failed: ${res.status}`);
			}
		} catch (error) {
			log(`usage binding: snapshot read failed: ${String(error)}`);
		}
		const credentialIdsFor = (accountId: string): number[] =>
			providerCredentials.get(accountId) ?? [];

		/**
		 * Wrap a worker so every delivered turn leaves exactly one run row.
		 *
		 * The supervisor is what decides to prompt, so this wrapper is the only
		 * place a turn is observable start to finish. The row opens before the
		 * prompt and closes after it, including when the turn throws: a failed
		 * turn is the one an operator most needs to find, and the alternative to
		 * recording it is a history that only ever shows successes.
		 */
		const recordRuns = (
			worker: SupervisedWorker,
		): SupervisedWorker &
			Partial<Pick<WorkerHandle, "sandboxed" | "fingerprint" | "pid">> => ({
			get name() {
				return worker.name;
			},
			get state() {
				return worker.state;
			},
			// Pass the sandbox flag through: the status mapping reads it for the
			// operator's shield (ADR-005), and a wrapper that silently drops it
			// downgrades every wire answer to "unsandboxed".
			get sandboxed() {
				return (worker as Partial<Pick<WorkerHandle, "sandboxed">>).sandboxed;
			},
			// Pass the live pid through too: the registry write and the status
			// mapping both read it off this wrapper, and dropping it here would
			// make every wire/registry answer say "no process" for a live worker.
			get pid() {
				return (worker as Partial<Pick<WorkerHandle, "pid">>).pid;
			},
			// Pass the definition fingerprint through too: the staleness check
			// compares it against the store, and a wrapper that drops it disables
			// the rebuild-on-change path (T-505).
			get fingerprint() {
				return (worker as Partial<Pick<WorkerHandle, "fingerprint">>)
					.fingerprint;
			},
			prompt: async (message) => {
				if (!recording) return await worker.prompt(message);
				const id = db.startRun({
					agent: worker.name,
					trigger: triggerContext.getStore() ?? "room",
					startedAt: now(),
				});
				try {
					await worker.prompt(message);
					// The turn may have outlived the daemon: shutdown already closed
					// this row as interrupted, and `finishRun` leaves it that way.
					if (recording) db.finishRun({ id, outcome: "ok", endedAt: now() });
				} catch (error) {
					if (recording) {
						db.finishRun({ id, outcome: "error", endedAt: now() });
					}
					throw error;
				}
			},
			park: async () => {
				await worker.park();
				markAgentRuntime(worker.name, worker.state, null);
			},
			resume: async () => {
				await worker.resume();
				markAgentRuntime(
					worker.name,
					worker.state,
					(worker as Partial<Pick<WorkerHandle, "pid">>).pid ?? null,
				);
			},
			stop: async () => {
				await worker.stop();
				markAgentRuntime(worker.name, "stopped", null);
			},
		});

		/**
		 * Raw markdown for each agent a peer names in `spawns:`.
		 *
		 * A spawn target is an ordinary OMP task agent, so it is read from the
		 * agent dir's native `agents/` directory rather than from the peer store,
		 * which holds durable peers. `materializeWorker` writes these into the
		 * worker's private agent dir and refuses to build a root when one is
		 * missing — a peer whose closure cannot be resolved therefore fails to
		 * start, and only that peer does.
		 */
		const spawnSourcesFor = async (
			peer: PeerDefinition,
		): Promise<Record<string, string>> => {
			const sources: Record<string, string> = {};
			if (peer.spawns === "*") return sources;
			for (const name of peer.spawns) {
				const path = join(agentDir, "agents", `${name}.md`);
				try {
					sources[name] = await readFile(path, "utf8");
					continue;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				// A peer may also name another peer; the store already parsed it,
				// so render the native fields the spawned agent needs.
				const spawned = definitions.get(name);
				if (!spawned) {
					throw new Error(
						`Peer ${peer.name} names spawn ${name}, which is neither a task agent in ${path} nor a peer in the store`,
					);
				}
				const frontmatter = [
					`name: ${JSON.stringify(spawned.name)}`,
					`description: ${JSON.stringify(spawned.description)}`,
				].join("\n");
				sources[name] = `---\n${frontmatter}\n---\n${spawned.body}`;
			}
			return sources;
		};

		/**
		 * Parentage as the daemon knows it, keyed by child.
		 *
		 * Spawn-time state, never frontmatter (ADR-011). Seeded from the
		 * persisted registry at boot so the tree outlives a restart, and the
		 * only writer is `spawnPeer` (an edge appears) or the kill path (an
		 * edge is removed).
		 */
		const parents = new Map<string, string>();

		/**
		 * The configuration each account was first registered under.
		 *
		 * The supervisor refuses to see one account described two ways, which
		 * is correct — an account cannot be metered and unmetered at once — but
		 * a child placed on its parent's account arrives declaring nothing.
		 * Remembering the account's own configuration is what lets it join
		 * without contradicting the peer that established it.
		 */
		const accountConfigs = new Map<
			string,
			{ mode: "subscription" | "metered"; budgetUsd: number | undefined }
		>();
		for (const row of db.listAgents()) {
			// Both spellings of "root": absent on write, null on read.
			if (row.parent != null) parents.set(row.name, row.parent);
		}

		/** The family channel a parent's children read in place of its rooms. */
		const familyChannel = (parent: string): string => `#${parent}-team`;

		/**
		 * Walk from `parent` to the root, or throw naming the loop it closes.
		 *
		 * The path is the whole point of the message: told only that a spawn
		 * was rejected, a caller cannot see which existing edge made its
		 * request impossible.
		 */
		const assertNoCycle = (child: string, parent: string): void => {
			const path = [child];
			let cursor: string | undefined = parent;
			while (cursor !== undefined) {
				path.push(cursor);
				if (cursor === child) {
					throw new InvalidParamsError(
						"parent",
						`Spawning ${child} under ${parent} would close a cycle: ${path.reverse().join(" -> ")}`,
					);
				}
				cursor = parents.get(cursor);
			}
		};

		/** Every peer beneath `name`, deepest last. */
		const descendantsOf = (name: string): string[] => {
			const found: string[] = [];
			const frontier = [name];
			while (frontier.length > 0) {
				const current = frontier.pop() as string;
				for (const [child, parent] of parents) {
					if (parent !== current || found.includes(child)) continue;
					found.push(child);
					frontier.push(child);
				}
			}
			return found;
		};

		/** Materialize, launch, and register one peer. Idempotent by name. */
		const spawnPeer = async (
			name: string,
			options: { parent?: string } = {},
		): Promise<AgentSpawnResult> => {
			const definition = definitions.get(name);
			if (!definition) {
				throw new InvalidParamsError("name", `Unknown peer: ${name}`);
			}

			// Parentage is validated before anything is built, and before the
			// idempotence shortcut below: an impossible edge must be refused on
			// its own terms rather than answered "already running", which would
			// report success for a spawn that never happened.
			const parent = options.parent;
			if (parent !== undefined) {
				const record = peers.get(parent);
				if (!record) {
					throw new InvalidParamsError("parent", `Unknown parent: ${parent}`);
				}
				// Cycles before liveness. A loop is a structural fact about the
				// tree that no restart can repair, while "stopped" is a passing
				// condition — and a cascade stops the very ancestors a cycle runs
				// through, so checking liveness first answers "parent is stopped"
				// for a request that would still be impossible once it was not.
				assertNoCycle(name, parent);
				if (record.worker.state === "stopped") {
					throw new InvalidParamsError(
						"parent",
						`Parent ${parent} is stopped and cannot deploy ${name}`,
					);
				}
			}

			const existing = peers.get(name);
			if (existing && existing.worker.state !== "stopped") {
				return { name, state: existing.worker.state };
			}
			const parentRecord = parent === undefined ? undefined : peers.get(parent);

			// Inheritance is exactly two things (ADR-011): the parent's account,
			// and a family channel in place of — never in addition to — the
			// parent's rooms. Budget stays explicit, because a shared ceiling
			// lets one runaway child starve its siblings invisibly.
			const accountId = parentRecord
				? parentRecord.accountId
				: accountIdFor(definition);
			const peerRooms =
				parent === undefined
					? (definition.rooms ?? [])
					: [...(definition.rooms ?? []), familyChannel(parent)];

			// Materialize from a definition whose rooms are the ones this peer
			// actually subscribes to. The supervisor's staleness check subtracts
			// membership by re-hashing the on-disk definition with the rooms the
			// live worker's fingerprint was taken over, so a child fingerprinted
			// over its bare `rooms:` while subscribed to the family channel
			// compares unequal on every single delivery and rebuilds forever.
			const materialized: PeerDefinition = {
				...definition,
				rooms: peerRooms,
			};

			const controlToken = mintControlToken();
			const worker = recordRuns(
				await workerFactory({
					peer: materialized,
					cwd: projectDir,
					agentDir,
					rootDir: join(stateDir, "workers", name),
					discoveredAgentNames,
					inferenceGateway: {
						url: gateway.url,
						token: gateway.issueWorkerToken({
							workerId: name,
							credentialIds: credentialIdsFor(accountId),
						}).token,
					},
					sourceSpawnAgents: await spawnSourcesFor(definition),
					socketPath,
					controlToken,
					inProcess: inProcessWorkers,
				}),
			);
			activateControlToken(name, controlToken);

			for (const room of peerRooms) await ensureRoom(room);

			// Quota is an account property (ADR-006), and this peer is on the
			// parent's account, so the account's existing configuration governs
			// it. That is not budget inheritance in ADR-011's sense: the child
			// gets no ceiling of its own and declares none, it is simply
			// metered by the account it was placed on. Re-registering the same
			// account under a second configuration is what the supervisor
			// refuses, and rightly — one account cannot be metered and
			// unmetered at once.
			const accountConfig = accountConfigs.get(accountId) ?? {
				mode:
					definition.autonomy?.budgetUsd === undefined
						? ("subscription" as const)
						: ("metered" as const),
				// The cap itself: without it a metered account's warnings and
				// parks can never fire (T-506).
				budgetUsd: definition.autonomy?.budgetUsd,
			};
			accountConfigs.set(accountId, accountConfig);

			await supervisor.register({
				worker,
				accountId,
				mode: accountConfig.mode,
				rooms: peerRooms,
				// Parsed wake filters govern delivery; absent means
				// subscription-scoped only (T-509).
				wake: definition.wake,
				budgetUsd: accountConfig.budgetUsd,
			});

			if (parent === undefined) parents.delete(name);
			else parents.set(name, parent);

			peers.set(name, {
				worker,
				accountId,
				model: Array.isArray(definition.model)
					? definition.model[0]
					: definition.model,
				rooms: peerRooms,
				...(parent === undefined ? {} : { parent }),
			});
			// Write-through: the live map above is what requests read, and this
			// row is what a restart and the orphan sweep read instead of guessing.
			db.upsertAgent({
				name,
				definitionPath: definitionPathFor(definition),
				status: worker.state,
				workerPid: worker.pid ?? null,
				cwd: projectDir,
				startedAt: now(),
				parent: parent ?? null,
			});
			return { name, state: worker.state };
		};

		/**
		 * Stop a peer and, by default, everything under it.
		 *
		 * Cascading is the default because a child under a dead parent answers
		 * to nobody, and ADR-011 makes that state impossible rather than merely
		 * rare. `keepChildren` is the explicit opt-out and reparents to root,
		 * written through immediately so a restart cannot resurrect the edge an
		 * operator just cut.
		 */
		const killPeer = async (
			name: string,
			options: { keepChildren: boolean },
		): Promise<void> => {
			const doomed = options.keepChildren
				? [name]
				: [name, ...descendantsOf(name)];
			// Deepest first: a parent outliving its children for the duration of
			// the sweep is the ordering that never shows a live orphan.
			for (const peerName of doomed.reverse()) {
				const record = peers.get(peerName);
				if (!record) continue;
				try {
					await record.worker.stop();
				} catch (error) {
					log(`stopping ${peerName}: ${String(error)}`);
				}
				revokeControlToken(peerName);
				markAgentRuntime(peerName, "stopped", null);
				if (peerName === name) continue;
				// A cascaded child keeps its edge: the subtree is stopped, not
				// rearranged, so a later restart rebuilds the same shape.
			}

			if (!options.keepChildren) return;
			for (const [child, parent] of [...parents]) {
				if (parent !== name) continue;
				parents.delete(child);
				const record = peers.get(child);
				if (record) peers.set(child, { ...record, parent: undefined });
			}
			db.reparentChildrenToRoot(name);
		};

		/** Arm one cron schedule; the handler posts the prompt into its room. */
		const armCron = (
			peer: PeerDefinition,
			schedule: Schedule,
			index: number,
		): void => {
			const id = `${peer.name}:schedule:${index}`;
			const room = schedule.room ?? peer.rooms?.[0];
			const record: ScheduleRecord = {
				id,
				peer: peer.name,
				cron: schedule.cron,
				action: schedule.prompt,
				enabled: true,
				nextFireAt: nextCronTime(schedule.cron, now()),
			};
			schedules.set(id, record);
			db.upsertSchedule({
				id,
				cron: schedule.cron,
				action: schedule.prompt,
				payload: room === undefined ? null : JSON.stringify({ room }),
				nextFireAt: record.nextFireAt,
				enabled: true,
			});
			scheduler.add(id, {
				cron: schedule.cron,
				handler: async () => {
					record.nextFireAt = nextCronTime(schedule.cron, now());
					db.setScheduleNextFire(id, record.nextFireAt);
					if (room === undefined) return;
					await ensureRoom(room);
					// Posting through the supervisor is what wakes the peer; writing
					// to the store directly would fire into an empty room. The
					// trigger rides along so the run this produces is recorded as
					// the schedule firing rather than as somebody typing.
					await triggerContext.run(`schedule:${id}` as RunTrigger, async () => {
						await supervisor.post({
							room,
							author: HUMAN_AUTHOR,
							body: schedule.prompt,
						});
					});
				},
			});
		};

		/**
		 * Whether an operator disarmed a schedule before the last shutdown. The
		 * definition on disk still declares it, so a boot that re-armed
		 * everything it found would quietly undo that decision — this is the one
		 * piece of schedule state no file carries.
		 */
		const persisted = new Map(
			db.listSchedules().map((schedule) => [schedule.id, schedule]),
		);

		/**
		 * Peers in an order that starts a parent before its children.
		 *
		 * `spawnPeer` reads the live parent record for the account and family
		 * channel a child inherits, so a child started first would inherit from
		 * a peer that does not exist yet. A definition whose parent is missing
		 * never reaches this list — it is refused above as an orphan.
		 */
		const bootOrder = (names: string[]): string[] => {
			const ordered: string[] = [];
			const placed = new Set<string>();
			const place = (name: string): void => {
				if (placed.has(name)) return;
				placed.add(name);
				const parent = parents.get(name);
				if (parent !== undefined && names.includes(parent)) place(parent);
				ordered.push(name);
			};
			for (const name of names) place(name);
			return ordered;
		};

		/**
		 * Agents refused at boot because their parent is gone, by vanished
		 * parent.
		 *
		 * Status-only. Deliberately not a `peers` entry carrying a stub worker:
		 * `kill`, `inject`, `logs_tail`, and the shutdown sweep all drive
		 * `peers` records, and a placeholder among them would be a fake worker
		 * those paths would dutifully operate on. An orphan has no lifecycle, so
		 * it is held where only status reads it.
		 */
		const orphans = new Map<string, string>();

		// An agent whose ancestry no longer resolves is refused, not resumed
		// (ADR-011): orphanhood is made an impossible steady state rather than
		// swept up after the fact. The database walks the chain, so a grandchild
		// whose own parent survives is still refused when the peer above that is
		// gone — starting it would place it under a peer this same boot refused.
		//
		// The recorded edge stays the peer that actually deployed it, never the
		// ancestor that vanished: those differ below the first generation, and
		// reporting the break as the parent would draw an edge nobody created.
		// Which ancestor broke is said in the log, where the operator looks.
		for (const orphan of db.listOrphans(definitions.keys())) {
			orphans.set(orphan.name, parents.get(orphan.name) ?? orphan.missing);
			markAgentRuntime(orphan.name, "stopped", null);
			log(
				`peer ${orphan.name} not started: its ancestor ${orphan.missing} is gone from the registry`,
			);
		}
		const startable = [...definitions.keys()].filter(
			(name) => !orphans.has(name),
		);

		for (const name of bootOrder(startable)) {
			const definition = definitions.get(name);
			if (!definition) continue;
			try {
				// The persisted edge, not a fresh root: a boot that dropped it
				// would silently flatten the tree on every restart.
				await spawnPeer(definition.name, { parent: parents.get(name) });
			} catch (error) {
				// One peer that cannot start must not take the daemon with it: the
				// operator needs a running socket to see what failed and why.
				log(`peer ${definition.name} failed to start: ${String(error)}`);
				continue;
			}

			const declaredSchedules = definition.schedules ?? [];
			for (let index = 0; index < declaredSchedules.length; index++) {
				const schedule = declaredSchedules[index];
				if (!schedule) continue;
				const id = `${definition.name}:schedule:${index}`;
				if (persisted.get(id)?.enabled === false) {
					// Restored as the operator left it: listed, but with no timer and
					// no next fire, which is what disarmed means everywhere else.
					schedules.set(id, {
						id,
						peer: definition.name,
						cron: schedule.cron,
						action: schedule.prompt,
						enabled: false,
						nextFireAt: null,
					});
					continue;
				}
				armCron(definition, schedule, index);
			}

			// An automation carries no clock, so nothing is scheduled: it is listed
			// as a timeless entry until an event source exists to fire it.
			const declaredAutomations: Automation[] = definition.automations ?? [];
			for (let index = 0; index < declaredAutomations.length; index++) {
				const automation = declaredAutomations[index];
				if (!automation) continue;
				const id = `${definition.name}:automation:${index}`;
				const action = `${automation.event}: ${automation.prompt}`;
				const enabled = persisted.get(id)?.enabled ?? true;
				schedules.set(id, {
					id,
					peer: definition.name,
					cron: null,
					action,
					enabled,
					nextFireAt: null,
				});
				db.upsertSchedule({
					id,
					cron: null,
					action,
					payload: null,
					nextFireAt: null,
					enabled,
				});
			}
		}

		const armSchedule = (
			id: string,
			enabled: boolean,
		): ScheduleInfo | undefined => {
			const record = schedules.get(id);
			if (!record) return undefined;
			record.enabled = enabled;

			// An automation has no timer to arm or cancel; only its flag moves.
			if (record.cron !== null) {
				if (enabled) {
					const peer = definitions.get(record.peer);
					const index = Number(id.slice(id.lastIndexOf(":") + 1));
					const schedule = peer?.schedules?.[index];
					if (peer && schedule) armCron(peer, schedule, index);
				} else {
					scheduler.remove(id);
					record.nextFireAt = null;
					db.setScheduleNextFire(id, null);
				}
			}

			// The operator's decision is the one thing a restart cannot re-derive
			// from the definition, so it is written through immediately rather
			// than at shutdown, which a crash never reaches.
			db.setScheduleEnabled(id, enabled);

			return {
				id: record.id,
				cron: record.cron,
				action: record.action,
				nextFireAt: record.nextFireAt,
				enabled: record.enabled,
			};
		};

		const bumpAccount = async (
			accountId: string,
			budgetUsd: number,
		): Promise<string[]> => {
			const parkedBefore = [...peers]
				.filter(
					([, record]) =>
						record.accountId === accountId && record.worker.state === "parked",
				)
				.map(([name]) => name);

			// The supervisor's bump raises the ceiling, resets the meter latch,
			// posts the resume, and delivers the backlog; the registry's raw
			// bump alone would leave the old ceiling in the room message. Keep the
			// daemon's copy in sync too: the usage poller divides cumulative spend
			// by this ceiling, so a stale denominator would re-park the account on
			// its first post-bump poll.
			supervisor.bumpBudget(accountId, budgetUsd);
			const config = accountConfigs.get(accountId);
			if (config) accountConfigs.set(accountId, { ...config, budgetUsd });
			await supervisor.settled();

			return parkedBefore.filter(
				(name) => peers.get(name)?.worker.state === "running",
			);
		};

		/**
		 * Remove `workers/` directories belonging to no registered peer.
		 *
		 * The registry is the persisted one, not just the peers this boot
		 * happened to start: a peer whose definition was moved away still owns
		 * its materialized root, and a sweep that only knew about live peers
		 * would delete it. Conservative and loud — each removal is reported,
		 * because a silent deleter of directories is not something to debug at
		 * 3am — and a failed removal is logged rather than aborting the boot.
		 */
		const sweepOrphanWorkers = async (): Promise<void> => {
			const workersDir = join(stateDir, "workers");
			let entries: string[];
			try {
				entries = await readdir(workersDir);
			} catch (error) {
				// No workers directory yet is the normal first boot, not a fault.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}

			const known = new Set(db.listAgents().map((agent) => agent.name));
			for (const entry of entries) {
				if (known.has(entry)) continue;
				const path = join(workersDir, entry);
				try {
					await rm(path, { recursive: true, force: true });
					log(`swept orphaned worker directory: ${path}`);
				} catch (error) {
					log(`could not sweep ${path}: ${String(error)}`);
				}
			}
		};

		await sweepOrphanWorkers();

		/**
		 * Write a definition through the store, then refresh the daemon's own
		 * view of it.
		 *
		 * The store is disk; `definitions` is what `spawnPeer` resolves a name
		 * against. Updating only the first is what makes a freshly created peer
		 * answer "unknown peer" on the spawn its creator was told to make next,
		 * so both move together or neither does.
		 */
		const writeDefinition = async (
			fields: PeerDefinitionFields,
			options: { overwrite: boolean },
		): Promise<PeerDefinition> => {
			const definition = await store.write(fields, options);
			definitions.set(definition.name, definition);
			if (!discoveredAgentNames.includes(definition.name)) {
				discoveredAgentNames.push(definition.name);
			}
			return definition;
		};

		const context: DaemonContext = {
			rooms,
			supervisor,
			peers,
			knownRooms,
			schedules,
			orphans,
			store,
			writeDefinition,
			startedAt: now(),
			now,
			ensureRoom,
			spawnPeer,
			killPeer,
			armSchedule,
			bumpAccount,
		};

		const socket = await startControlSocket({
			socketPath,
			context,
			identities,
		});
		started.push(() => socket.close());

		/**
		 * The console, unless the operator asked for a headless daemon.
		 *
		 * Serving it is the point of the surface, so it is on by default; the
		 * kill switch exists for a daemon nobody is meant to look at. The URL
		 * carries the token, so it is announced once and never written to disk
		 * beside the token file it would duplicate.
		 */
		let consoleApi: ConsoleApi | undefined;
		let consoleUrl: string | undefined;
		if (env.OMA_CONSOLE !== "0") {
			const token = operatorToken;
			// A typo'd port must not quietly become a random one: set means valid,
			// and anything else refuses the boot (the materializer's standard).
			let consolePort = 0;
			const portEnv = env.OMA_CONSOLE_PORT;
			if (portEnv !== undefined && portEnv !== "") {
				if (!/^\d+$/.test(portEnv)) {
					throw new Error(
						`Invalid OMA_CONSOLE_PORT: ${JSON.stringify(portEnv)}`,
					);
				}
				const parsed = Number.parseInt(portEnv, 10);
				if (parsed < 0 || parsed > 65535) {
					throw new Error(`OMA_CONSOLE_PORT out of range: ${portEnv}`);
				}
				consolePort = parsed;
			}
			consoleApi = await startConsoleApi({
				rooms,
				supervisor,
				peers,
				knownRooms,
				peerStore: store,
				ensureRoom,
				token,
				// Loopback only. Binding wider is T-1004's decision, not a
				// default this task gets to make.
				hostname: "127.0.0.1",
				port: consolePort,
			});
			// Registered before anything below can throw, so a failed boot takes
			// the listener down with it rather than leaving a bound port.
			const api = consoleApi;
			started.push(() => api.close());
			consoleUrl = `${api.url}/?token=${encodeURIComponent(token)}`;
			log(`console: ${consoleUrl}`);
			// Persist the URL so a later `omp-agent console` can recover it
			// without the launcher still being around to relay it.
			await writeFile(join(stateDir, "console-url"), consoleUrl, {
				encoding: "utf8",
				mode: TOKEN_MODE,
			});
			await chmod(join(stateDir, "console-url"), TOKEN_MODE);
		} else {
			// A previous boot may have written a console URL; remove it so the
			// CLI can tell "no console for this daemon" apart from a stale file.
			await rm(join(stateDir, "console-url"), { force: true });
		}
		// Always called, console or not: the CLI launcher is holding a pipe open
		// for this and needs to stop waiting either way.
		options.announce?.(consoleUrl);

		/** One scoped gateway bearer per metered account, minted on first poll. */
		const usageTokens = new Map<string, string>();
		const usageTokenFor = (accountId: string): string => {
			const existing = usageTokens.get(accountId);
			if (existing) return existing;
			const token = gateway.issueWorkerToken({
				workerId: `usage-meter:${accountId}`,
				credentialIds: credentialIdsFor(accountId),
			}).token;
			usageTokens.set(accountId, token);
			return token;
		};

		const pollOnce = async (): Promise<void> => {
			for (const [accountId, config] of accountConfigs) {
				if (config.mode !== "metered" || config.budgetUsd === undefined)
					continue;
				const hasRunningPeer = [...peers.values()].some(
					(record) =>
						record.accountId === accountId && record.worker.state === "running",
				);
				if (!hasRunningPeer) continue;

				try {
					const res = await fetch(
						`${gateway.url}/v1/usage?provider=${encodeURIComponent(accountId)}`,
						{
							headers: {
								Authorization: `Bearer ${usageTokenFor(accountId)}`,
							},
						},
					);
					if (!res.ok) throw new Error(`gateway usage failed: ${res.status}`);
					const body = (await res.json()) as {
						reports?: {
							limits?: { amount?: { unit?: string; used?: number } }[];
						}[];
					};
					// ponytail: provider reports can expose overlapping spend windows;
					// take the largest USD window to avoid double-counting. Upgrade when
					// account budgets can target a named provider window.
					let dollarsBurned = 0;
					for (const report of body.reports ?? []) {
						for (const limit of report.limits ?? []) {
							const used = limit.amount?.used;
							if (
								limit.amount?.unit === "usd" &&
								typeof used === "number" &&
								Number.isFinite(used)
							) {
								dollarsBurned = Math.max(dollarsBurned, used);
							}
						}
					}
					supervisor.registry.updateMeter(
						accountId,
						Math.min(1, Math.max(0, dollarsBurned / config.budgetUsd)),
					);
					await supervisor.settled();
				} catch (error) {
					log(`usage ${accountId}: ${String(error)}`);
				}
			}
		};
		// Single-flight: a slow poll must not overlap the next tick, and shutdown
		// has to await whatever is in flight before tearing down the gateway.
		let usageInFlight: Promise<void> | undefined;
		const tickUsage = (): void => {
			if (usageInFlight) return;
			usageInFlight = pollOnce().finally(() => {
				usageInFlight = undefined;
			});
		};
		const usagePollMs = options.usagePollMs ?? 60_000;
		const usagePollTimer = setInterval(tickUsage, usagePollMs);
		const stopUsageLoop = async (): Promise<void> => {
			clearInterval(usagePollTimer);
			await usageInFlight;
		};
		started.push(stopUsageLoop);
		options.onUsagePoller?.({ pollOnce });

		let closed = false;
		return {
			socketPath,
			pidPath,
			...(consoleUrl === undefined ? {} : { consoleUrl }),
			close: async () => {
				if (closed) return;
				closed = true;

				// The usage loop first: it fetches through the gateway and posts
				// through the supervisor, so a poll in flight after either closes is a
				// call against a torn-down dependency. Await the in-flight tick, not
				// just the timer, before anything below tears those down.
				await stopUsageLoop();

				// Reverse order: the console and the socket first, so no new request
				// arrives; then the workers, then the machinery they depend on, and
				// only then the files that advertise this daemon's existence.
				//
				// The console goes before the room store on purpose: its live feed
				// polls that store while a browser is connected, and closing the
				// database under a running poller is a query against a closed
				// handle.
				await consoleApi?.close();
				await socket.close();
				await supervisor.settled();
				for (const record of peers.values()) {
					try {
						await record.worker.stop();
					} catch (error) {
						log(`stopping ${record.worker.name}: ${String(error)}`);
					}
				}
				scheduler.stop();

				// A turn still in flight belongs to a process about to stop
				// existing. Closing its row as interrupted is the last write; after
				// it, `recording` is off so a late completion cannot reopen the
				// question — or touch a closed database.
				const interrupted = db.interruptOpenRuns(now());
				if (interrupted > 0) {
					log(`closed ${interrupted} interrupted run(s) at shutdown`);
				}
				for (const name of peers.keys())
					markAgentRuntime(name, "stopped", null);
				recording = false;
				db.close();

				await gateway.close();
				await rooms.close();
				await hosting.close();
				await rm(pidPath, { force: true });
				await rm(socketPath, { force: true });
				await rm(join(stateDir, "console-url"), { force: true });
			},
		};
	} catch (error) {
		while (started.length > 0) await started.pop()?.();
		throw error;
	}
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * Run the daemon and wire its shutdown to the host's cleanup registry.
 *
 * Importing `@oh-my-pi/pi-ai/auth-broker` pulls in pi-utils' postmortem module,
 * which installs its own `SIGTERM`/`SIGINT` handlers that run the registered
 * cleanups and then hard-exit (`postmortem.ts:442-444`). A competing
 * `process.on("SIGTERM")` here loses that race: the host exits 143 partway
 * through, leaving the pidfile behind and the workers unstopped. Registering
 * with the same registry makes shutdown a cleanup the host awaits instead of a
 * handler it races.
 */
async function runDaemon(): Promise<void> {
	const handle = await bootDaemon({
		logger: (message) => {
			process.stderr.write(`${message}\n`);
		},
		// The launcher holds this pipe open waiting for exactly this line. It is
		// the only thing ever written to stdout, and stdout is closed straight
		// after — including when there is no console to announce — so the
		// launcher stops waiting instead of hanging for the daemon's lifetime.
		announce: (url) => {
			if (url !== undefined) process.stdout.write(`${url}\n`);
			process.stdout.end();
		},
	});
	postmortem.register("oh-my-agent-daemon", () => handle.close());
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const verb = argv[0] ?? "daemon";
	if (verb !== "daemon") {
		// The CLI handles its own dispatch, usage, and exit codes.
		const { runCli } = await import("./cli");
		const code = await runCli(argv, {
			agentDir: process.env.PI_CODING_AGENT_DIR,
		});
		process.exit(code);
	}

	if (process.env[DETACHED_ENV] === "1") {
		await runDaemon();
	} else {
		// Surviving a closed terminal is the product's core claim, so the
		// launching process must not be the daemon: re-spawn detached, print
		// where to reach the child, and exit.
		//
		// stdout is a pipe rather than `ignore` so the child can hand back the
		// one thing only it knows — the console URL, with the port the OS just
		// assigned. It writes that line and nothing else to stdout, so the pipe
		// closing when this launcher exits can never break a later write. The
		// alternative, polling the child's `console-url` file, cannot tell a
		// fresh line from one a crashed daemon left behind, and clearing that
		// file first would delete the URL of a daemon that is still running when
		// this boot is refused as a double start.
		const child = Bun.spawn({
			cmd: [process.execPath, import.meta.path, ...argv],
			env: { ...process.env, [DETACHED_ENV]: "1" },
			stdio: ["ignore", "pipe", "ignore"],
			detached: true,
		});
		child.unref();
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
		process.stdout.write(`${join(agentDir, STATE_DIR, "daemon.sock")}\n`);

		// Stop at the first newline rather than at EOF: the child closes stdout
		// right after announcing, but a launcher that waited for EOF regardless
		// would hang for the daemon's whole lifetime if it ever stopped doing
		// so. A child that dies on the way up closes the pipe and ends this too.
		let readiness = "";
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		try {
			while (!readiness.includes("\n")) {
				const { done, value } = await reader.read();
				if (done) break;
				readiness += decoder.decode(value, { stream: true });
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const url = readiness.split("\n", 1)[0]?.trim();
		if (url !== undefined && url.length > 0) process.stdout.write(`${url}\n`);

		process.exit(0);
	}
}
