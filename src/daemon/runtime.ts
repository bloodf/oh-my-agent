/**
 * Purpose: The daemon's composition root (§4.1). `omp-agent daemon` boots every
 * subsystem in dependency order, registers the peers the store lists, serves the
 * T-507 control socket and the operator console, and keeps running after the
 * launching terminal closes. Shutdown reverses that order so a stop never
 * strands a parked watcher or a half-stopped worker.
 *
 * Public API: `bootDaemon(options): Promise<DaemonHandle>` and, when run as a
 * program, the `daemon` CLI verb that re-spawns itself detached.
 *
 * Upstream deps: `./boot` (broker hosting), `./credential-gateway`,
 * `../rooms/store`, `./scheduler`, `./supervisor`, `./peer-store`, `./socket`,
 * `./console-api`, `./operations` (composed once here and handed to both the
 * socket and console), and the `OMA_REMOTE` / `OMA_CONSOLE_ORIGIN` environment
 * contract; through the default worker factory, `./materializer` plus
 * `../worker/lifecycle`.
 *
 * Downstream consumers: the CLI entry point below, plus T-508's persistence and
 * T-504's TUI, which reach this process only through the socket.
 *
 * Failure modes: a live pidfile for the same agent dir refuses boot rather than
 * letting two daemons share one vault, socket, and room database. Invalid
 * exposure configuration, including an unsafe or missing external origin when
 * remote mode serves the console, is rejected before the pidfile or any
 * listener. A headless remote daemon (`OMA_CONSOLE=0`) has no console URL to
 * expose and so needs no origin. Anything started when a later step fails is
 * closed before the error propagates.
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
import { RoomPlans } from "../rooms/plans";
import { RoomStore } from "../rooms/store";
import type {
	Automation,
	PeerDefinition,
	Schedule,
} from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";
import type {
	AgentSpawnResult,
	DaemonStopResult,
	ModelsListResult,
	PresetsListResult,
	RoomInfo,
	ScheduleInfo,
} from "../shared/protocol";
import { PACKAGE_VERSION } from "../shared/version";
import type { WorkerHandle } from "../worker/lifecycle";
import { startInProcessWorker, startWorker } from "../worker/lifecycle";
import { resolveBrokerHosting } from "./boot";
import type { ConsoleApi } from "./console-api";
import { isLoopback, startConsoleApi } from "./console-api";
import { startCredentialGateway } from "./credential-gateway";
import type { RunTrigger } from "./db";
import { DaemonDb } from "./db";
import { resolveDefaultModel } from "./default-model";
import { seedDefaultPeers } from "./default-peers";
import type { ScopedInferenceGateway } from "./inference-gateway";
import {
	listRoutableModels,
	startScopedInferenceGateway,
} from "./inference-gateway";
import { materializeWorker } from "./materializer";
import { createOperations } from "./operations";
import type { PeerDefinitionFields } from "./peer-store";
import { createPeerStore, resolvePeerStoreRoots } from "./peer-store";
import { listPresets as listShippedPresets } from "./presets";
import { nextCronTime, Scheduler } from "./scheduler";
import type {
	ControlIdentity,
	DaemonContext,
	PeerRecord,
	ScheduleRecord,
} from "./socket";
import { HUMAN_AUTHOR, InvalidParamsError, startControlSocket } from "./socket";
import type { WorkerBackend } from "./startup";
import type { SupervisedWorker } from "./supervisor";
import { Supervisor } from "./supervisor";
import { WebAttachments } from "./web-attachments";
import { createWebChats } from "./web-chats";

/** Everything the daemon owns lives under this directory in the agent dir. */
const STATE_DIR = "oh-my-agent";

/**
 * Where the detached daemon's stderr is persisted, beside the pidfile.
 *
 * Appended across boots rather than truncated: the output that explains why a
 * daemon died is written by the boot before the restart, and a restart loop
 * that truncated would erase the evidence exactly when it is needed.
 */
const LOG_FILE = "daemon.log";

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
	inferenceGateway: { url: string; token: string; maxTokens?: number };
	/** Raw markdown for each agent the peer names in `spawns:`. */
	sourceSpawnAgents: Record<string, string>;
	/** Absolute path of the daemon control socket, exported to the worker env. */
	socketPath: string;
	/** Bearer credential for this worker's control-socket identity. */
	controlToken: string;
	/**
	 * The `provider/id` to run on when the peer's definition declares none:
	 * OMP's own default model role. Set only in that case, because it
	 * overrides the definition's `model:` wherever it is passed.
	 */
	model?: string;
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
	/**
	 * Copy the shipped staff peers into the user store before definitions
	 * load, once per store. Off by default so a harness boots exactly the
	 * peers it wrote; the real launcher turns it on.
	 */
	seedDefaultPeers?: boolean;
	/**
	 * The `provider/id` a peer runs on when it declares no model. Defaults
	 * to OMP's default model role for `agentDir`; a test passes its own.
	 */
	defaultModel?: string;
}

export interface DaemonHandle {
	socketPath: string;
	pidPath: string;
	/** Where this daemon's stderr is persisted, across restarts. */
	logPath: string;
	/** Loopback listener URL for a trusted host-local proxy. Never persisted or announced. */
	consoleListenerUrl?: string;
	/** Where the console is served, token included; absent when disabled. */
	consoleUrl?: string;
	/**
	 * Close this daemon, or join the close already running.
	 *
	 * Memoized: `daemon_stop` acknowledges before shutting down, so the close it
	 * schedules belongs to no caller. Calling this returns that same shutdown
	 * rather than starting a second one or reporting done while it is still
	 * under way.
	 */
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
 * Refusal from `claimPidfile` when a live daemon already owns this profile.
 *
 * A distinct type because it is not a malfunction: the operator asked for a
 * daemon and there is one. `runDaemon` answers it by pointing the launcher at
 * the daemon that exists, rather than letting it travel out as an uncaught
 * exception — which is what filled the operator's `daemon.log` with 23 stack
 * traces, one per TUI session start.
 */
export class AlreadyRunningError extends Error {
	constructor(
		readonly pid: number,
		pidPath: string,
	) {
		super(
			`oh-my-agent daemon is already running for this profile (pid ${pid}, ${pidPath})`,
		);
		this.name = "AlreadyRunningError";
	}
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
			if (alive) throw new AlreadyRunningError(pid, pidPath);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeFile(pidPath, String(process.pid), "utf8");
}

/**
 * Whether the pidfile still names this process.
 *
 * The guard on shutdown: a daemon whose pidfile was taken over — by a later
 * boot that found this one unresponsive, or by an operator repairing state —
 * no longer owns the socket, console URL, and pidfile that `close()` deletes,
 * and removing them would tear down whichever daemon does.
 */
async function ownsPidfile(pidPath: string): Promise<boolean> {
	try {
		const recorded = (await readFile(pidPath, "utf8")).trim();
		return recorded === String(process.pid);
	} catch {
		// No pidfile is no ownership: something already cleaned up, or never
		// wrote one, and either way this process cannot claim it.
		return false;
	}
}

/** Where the operator token lives, and the only mode it may have. */
const TOKEN_FILE = "console-token";
const TOKEN_MODE = 0o600;

/**
 * Where the per-install proxy shared secret lives, beside the operator token
 * and under the same mode. Minted only in remote mode: a loopback daemon has
 * no proxy to authenticate, and a file that gates nothing is a secret to
 * rotate for no reason.
 */
const PROXY_SECRET_FILE = "console-proxy-secret";

/**
 * Refuse a secret file that any other local process can read.
 *
 * Split out of the loader below because the check has to run twice: once in
 * the boot preflight, before a single listener opens, and once implicitly on
 * the load itself. A file that does not exist yet passes — it is minted at
 * 0600 further down, and refusing an absent file would refuse a first boot.
 */
async function verifySecretMode(path: string): Promise<void> {
	let mode: number;
	try {
		mode = (await stat(path)).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (mode === TOKEN_MODE) return;
	throw new Error(
		`${path} has mode ${mode.toString(8)}, not 0600: any local process can read the console token. ` +
			`Run 'chmod 600 ${path}' to keep this token, or delete the file to rotate it.`,
	);
}

/**
 * Load a stored secret, or mint one.
 *
 * A stored value is reused so the URL an operator bookmarked keeps working
 * across restarts; deleting the file is how you rotate. A file with looser
 * permissions than 0600 fails the boot rather than being quietly replaced:
 * regenerating would revoke the URL the operator is holding without saying so,
 * and leaving it would keep serving a secret every local process can read.
 *
 * Shared by the operator token and the proxy secret because the two have the
 * same lifecycle down to the mode — a second copy of this would be a second
 * place for the 0600 rule to drift out of.
 */
async function loadSecret(stateDir: string, file: string): Promise<string> {
	const path = join(stateDir, file);
	await verifySecretMode(path);
	try {
		const stored = (await readFile(path, "utf8")).trim();
		if (stored.length > 0) return stored;
		// An empty file is crash debris, not a secret: nothing was revoked by
		// replacing it, because it never gated anything.
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// 32 bytes of CSPRNG, base64url so it survives a URL without escaping.
	const secret = randomBytes(32).toString("base64url");
	// `mode` on write only applies to a file being created, so an existing
	// empty one is removed first rather than left with whatever mode it had.
	await rm(path, { force: true });
	await writeFile(path, secret, { encoding: "utf8", mode: TOKEN_MODE });
	// umask can mask bits off the create mode; set them explicitly.
	await chmod(path, TOKEN_MODE);
	return secret;
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
			...(options.model === undefined ? {} : { modelPattern: options.model }),
			cwd: options.cwd,
			agentDir: options.agentDir,
			fingerprint: fingerprintPeerDefinition(options.peer),
			appendSystemPrompt: options.peer.body,
			modelPattern,
			spawns,
			agentId: options.peer.name,
			toolbelt: {
				socketPath: options.socketPath,
				controlToken: options.controlToken,
				actor: options.peer.name,
			},
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
		...(options.model === undefined ? {} : { model: options.model }),
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
	const usesDefaultRpcWorker =
		options.workerFactory === undefined && !inProcessWorkers;
	const now = options.now ?? Date.now;
	const log = options.logger ?? (() => {});

	const stateDir = join(agentDir, STATE_DIR);
	const pidPath = join(stateDir, "daemon.pid");
	const socketPath = join(stateDir, "daemon.sock");
	const logPath = join(stateDir, LOG_FILE);

	await mkdir(stateDir, { recursive: true, mode: 0o700 });

	// ── Exposure preflight (ADR-012) ──────────────────────────────────────────
	//
	// Everything here runs before `claimPidfile`, and therefore before the
	// broker, the credential gateway, the control socket, and the console —
	// before any listener opens at all. That ordering is the acceptance
	// criterion, not a preference: refusing after `startCredentialGateway` has
	// returned would mean a routable-bind request had already opened a port,
	// and refusing after the pidfile would leave a dead daemon's claim behind
	// for the operator to clean up by hand.
	const remoteMode = env.OMA_REMOTE === "1";
	const fullControlSetting = env.OMA_REMOTE_FULL_CONTROL;
	if (
		fullControlSetting !== undefined &&
		fullControlSetting !== "0" &&
		fullControlSetting !== "1"
	)
		throw new Error("OMA_REMOTE_FULL_CONTROL must be 0 or 1");
	const remoteFullControl = fullControlSetting === "1";
	if (remoteFullControl && !remoteMode)
		throw new Error("OMA_REMOTE_FULL_CONTROL requires OMA_REMOTE=1");
	// Whether the console listens at all in this boot, decided here rather
	// than at the point of use: the origin requirement below has to see the
	// same value the console-startup branch checks later, or a boot could
	// pass this preflight for a headless daemon and then serve the console
	// anyway on a token-bearing URL it was never allowed to announce.
	const consoleEnabled = env.OMA_CONSOLE !== "0";
	let externalConsoleOrigin: string | undefined;
	const configuredConsoleOrigin = env.OMA_CONSOLE_ORIGIN;
	if (configuredConsoleOrigin !== undefined && configuredConsoleOrigin !== "") {
		let origin: URL;
		try {
			origin = new URL(configuredConsoleOrigin);
		} catch {
			throw new Error(
				`Invalid OMA_CONSOLE_ORIGIN: ${JSON.stringify(configuredConsoleOrigin)}`,
			);
		}
		if (
			!remoteMode ||
			origin.protocol !== "https:" ||
			origin.username !== "" ||
			origin.password !== "" ||
			origin.pathname !== "/" ||
			origin.search !== "" ||
			origin.hash !== ""
		) {
			throw new Error(
				`Invalid OMA_CONSOLE_ORIGIN: expected remote mode and an HTTPS origin without credentials, path, query, or hash; received ${JSON.stringify(configuredConsoleOrigin)}`,
			);
		}
		externalConsoleOrigin = `${origin.origin}/`;
	}
	// Remote mode with the console enabled must have an external origin: a
	// token-bearing URL announced or persisted over an untrusted network is
	// exactly the exposure ADR-012 exists to close. `OMA_CONSOLE=0` is the
	// documented escape hatch for a headless remote daemon (T-1204's
	// parentage build), which has no URL to leak in the first place.
	if (remoteMode && consoleEnabled && externalConsoleOrigin === undefined) {
		throw new Error(
			"OMA_CONSOLE_ORIGIN is required when OMA_REMOTE=1 and the console is enabled; set it to the external HTTPS origin the console is served behind, or set OMA_CONSOLE=0 for a headless remote daemon.",
		);
	}

	// Every listener the daemon owns, named with the variable that would move
	// it. Enumerated rather than checked ad hoc so a listener added later has
	// an obvious place to declare itself, and so the refusal can name the
	// variable the operator actually set.
	//
	// The credential gateway is on this list and is loopback-always: it never
	// joins remote auth, it is never proxied, and remote mode changes nothing
	// about it. It appears here only so that asking it to move is refused with
	// the same message as the other two.
	for (const variable of [
		"OMA_CONSOLE_HOST",
		"OMA_CONTROL_HOST",
		"OMA_CREDENTIAL_GATEWAY_HOST",
	]) {
		const requested = env[variable];
		if (requested === undefined || requested === "") continue;
		if (isLoopback(requested)) continue;
		// stderr, not the injected logger: a test's logger swallows this, and
		// the operator who set the variable is the one who has to read it.
		const reason =
			`${variable}=${requested} is not a loopback address. The daemon never binds a routable ` +
			`address in any mode, with or without OMA_REMOTE; expose it through a reverse proxy that ` +
			`forwards to the loopback listener (ADR-012).`;
		process.stderr.write(`daemon: ${reason}\n`);
		throw new Error(reason);
	}

	// The operator token's mode, checked before anything opens rather than at
	// the point of use: `loadSecret` would refuse a 0640 file too, but only
	// after the gateway and the broker were already listening.
	await verifySecretMode(join(stateDir, TOKEN_FILE));
	if (remoteMode) await verifySecretMode(join(stateDir, PROXY_SECRET_FILE));
	log(`trust model: ${remoteMode ? "remote" : "loopback"}`);

	await claimPidfile(pidPath);
	// A crash can leave the socket file behind; `Bun.serve` will not bind over it.
	await rm(socketPath, { force: true });

	/**
	 * Everything `close()` tears down, published once boot has built it.
	 *
	 * Declared here, above the `try`, for two reasons: the control socket starts
	 * serving long before boot finishes — and the first thing it can be asked to
	 * do is stop the daemon — and the failure path below has to be able to
	 * release a stop that is waiting on it.
	 *
	 * A promise rather than a mutable slot with a no-op default: a stop that
	 * arrived mid-boot would run that default, mark the daemon closed, and leave
	 * it serving. Awaiting instead makes an early stop wait for the real
	 * teardown and then run it, which is the only correct answer.
	 */
	const assembled = Promise.withResolvers<() => Promise<void>>();
	// Nobody awaits this on the happy path, and an unhandled rejection would
	// take the process down on a boot that is already failing loudly.
	assembled.promise.catch(() => {});

	// Anything started below must be closed if a later step throws, or a failed
	// boot leaves an orphaned broker and a locked database behind.
	const started: (() => Promise<void>)[] = [() => rm(pidPath, { force: true })];

	try {
		// Both credentials, minted before the first listener of any kind.
		//
		// Ahead of `resolveBrokerHosting`: the broker and the credential
		// gateway are listeners too, so minting further down — where the
		// operator token used to load — would make "generated at boot" true
		// only relative to the console. Inside the `try` rather than above it,
		// so a read or mint that throws unwinds the pidfile `started` already
		// holds instead of orphaning the claim.
		const operatorToken = await loadSecret(stateDir, TOKEN_FILE);
		// Remote mode only: a loopback daemon has no proxy to authenticate, so
		// a secret file there would be a credential on disk gating nothing.
		// Minted whether or not the console is served, so a daemon started with
		// `OMA_CONSOLE=0` still has one for the console a later boot serves.
		const proxySecret = remoteMode
			? await loadSecret(stateDir, PROXY_SECRET_FILE)
			: undefined;

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
		const plans = await RoomPlans.open(rooms.path);
		started.push(async () => plans.close());

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
		for (const room of await rooms.listRooms()) {
			knownRooms.set(room.id, { ...room, name: room.id });
		}
		const schedules = new Map<string, ScheduleRecord>();
		const definitions = new Map<string, PeerDefinition>();
		const identities = new Map<string, ControlIdentity>([
			[operatorToken, { kind: "operator" }],
		]);
		const inferenceGateways = new Map<
			string,
			{ gateway: ScopedInferenceGateway; brokerToken: string }
		>();
		let shuttingDown = false;
		const spawnInFlight = new Map<
			string,
			{ parent: string | undefined; promise: Promise<AgentSpawnResult> }
		>();
		const gatewayOperations = new Map<string, Promise<void>>();
		const runGatewayOperation = async <T>(
			workerId: string,
			operation: () => Promise<T>,
		): Promise<T> => {
			const previous = gatewayOperations.get(workerId);
			const { promise: current, resolve: release } =
				Promise.withResolvers<void>();
			gatewayOperations.set(workerId, current);
			await previous;
			try {
				return await operation();
			} finally {
				release();
				if (gatewayOperations.get(workerId) === current)
					gatewayOperations.delete(workerId);
			}
		};
		const inferenceGatewayFor = async (
			workerId: string,
			peer: PeerDefinition,
			credentialIds: number[],
		): Promise<ScopedInferenceGateway> => {
			if (shuttingDown) throw new Error("Daemon is shutting down");
			// The effective model, not the declared one: a peer with no `model:`
			// runs on the daemon default, and this gateway is scoped to whatever
			// the worker is about to be pointed at. Reading the definition here
			// refused every default-team peer before the override was reached.
			const selector = modelFor(peer);
			if (typeof selector !== "string")
				throw new Error(`Peer ${peer.name} declares no model`);
			const declared = Array.isArray(peer.model) ? peer.model[0] : peer.model;
			const onDefault =
				typeof declared !== "string" || declared.trim().length === 0;
			const trimmed = selector.trim();
			const slash = trimmed.indexOf("/");
			if (slash < 1 || slash === trimmed.length - 1)
				throw new Error(`Peer ${peer.name} model must be provider/id`);
			return runGatewayOperation(workerId, async () => {
				const previous = inferenceGateways.get(workerId);
				if (previous) {
					inferenceGateways.delete(workerId);
					await previous.gateway.close();
					gateway.revokeWorkerToken(previous.brokerToken);
				}
				const brokerToken = gateway.issueWorkerToken({
					workerId: `inference:${workerId}`,
					credentialIds,
				}).token;
				// A peer left on the OMP default is not the one that chose the
				// model; say where the choice lives when it cannot be routed.
				const describeUnroutable = (error: unknown): Error =>
					onDefault &&
					error instanceof Error &&
					error.message.startsWith("Unknown configured model")
						? new Error(
								`${error.message}: this is OMP's default model and the daemon cannot route to it (it is not in models.yml or the credential broker). Pick one from \`omp-agent models\` with \`/edit ${peer.name}\`.`,
							)
						: error instanceof Error
							? error
							: new Error(String(error));
				try {
					const scoped = await startScopedInferenceGateway({
						brokerUrl: gateway.url,
						brokerToken,
						modelsPath: join(agentDir, "models.yml"),
						provider: trimmed.slice(0, slash),
						modelId: trimmed.slice(slash + 1),
						workerToken: randomBytes(32).toString("base64url"),
					});
					inferenceGateways.set(workerId, { gateway: scoped, brokerToken });
					return scoped;
				} catch (error) {
					gateway.revokeWorkerToken(brokerToken);
					throw describeUnroutable(error);
				}
			});
		};
		const closeInferenceGateway = async (
			workerId: string,
			expected?: ScopedInferenceGateway,
		): Promise<void> =>
			runGatewayOperation(workerId, async () => {
				const entry = inferenceGateways.get(workerId);
				if (!entry || (expected && entry.gateway !== expected)) return;
				inferenceGateways.delete(workerId);
				try {
					await entry.gateway.close();
				} finally {
					gateway.revokeWorkerToken(entry.brokerToken);
				}
			});
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

		/**
		 * The console, once it exists.
		 *
		 * Declared before the supervisor purely for ordering: the supervisor
		 * publishes transitions and the console is what they are published to,
		 * but the console cannot be built until this boot is much further
		 * along. The `emit` hook below closes over this binding and reads it
		 * at call time, so transitions before the console is up are dropped
		 * (nobody is connected) and every one after it reaches the sockets.
		 */
		let consoleApi: ConsoleApi | undefined;
		const chats = await createWebChats({
			stateDir,
			onEvent: (chatId, event) =>
				consoleApi?.publish({ type: "chat", chatId, event }),
		});
		started.push(() => chats.close());
		const attachments = new WebAttachments(join(chats.storageDir, "clipboard"));
		await attachments.cleanup();
		let attachmentCleanup: Promise<void> | undefined;
		const attachmentTimer = setInterval(
			() => {
				if (attachmentCleanup) return;
				attachmentCleanup = attachments
					.cleanup()
					.catch((error) => log(`attachment cleanup: ${String(error)}`))
					.finally(() => {
						attachmentCleanup = undefined;
					});
			},
			60 * 60 * 1000,
		);
		const stopAttachmentCleanup = async () => {
			clearInterval(attachmentTimer);
			await attachmentCleanup;
		};
		started.push(stopAttachmentCleanup);
		const web = {
			chats,
			plans,
			attachments,
			remoteFullControl,
		};

		/**
		 * Add or remove one room in a peer's definition on disk. The single
		 * writer for membership edits that do not come through the console:
		 * `room_join`/`room_leave` and the supervisor's invite-by-mention.
		 */
		const setMembership = async (
			agent: string,
			room: string,
			action: "join" | "leave",
		): Promise<string[]> => {
			const current = await store.get(agent);
			if (!current) throw new Error(`Unknown peer: ${agent}`);
			const had = current.rooms ?? [];
			const next =
				action === "join"
					? [...new Set([...had, room])].sort()
					: had.filter((entry) => entry !== room);
			if (next.length === had.length && next.every((r) => had.includes(r))) {
				return had;
			}
			const { sha256: _sha, filePath: _path, ...fields } = current;
			// An empty list is dropped rather than written: the parser refuses
			// `rooms: []`, and a peer in no rooms is a peer with no `rooms:`.
			await writeDefinition(
				{
					...fields,
					...(next.length === 0 ? { rooms: undefined } : { rooms: next }),
				},
				{ overwrite: true },
			);
			return next;
		};

		const supervisor = new Supervisor({
			rooms,
			scheduler,
			now,
			onError: (error, peerName) => log(`peer ${peerName}: ${String(error)}`),
			invite: async (peerName, room) => {
				await ensureRoom(room);
				await setMembership(peerName, room, "join");
				log(`invited ${peerName} into ${room} by mention`);
			},
			// The supervisor's own transitions — park, resume, membership, and
			// the budget moves behind them — reach every connected console
			// through here (ADR-015). Spawn, kill, and schedule are the
			// daemon's, not the supervisor's, and publish from their own call
			// sites below.
			//
			// The closure is the whole wiring: `consoleApi` is `undefined`
			// while this is being constructed and is resolved on every later
			// call, so a hook captured now still finds the console built
			// hundreds of lines below.
			emit: (event) => {
				// Membership the supervisor applied on its own — an invite by
				// mention — must reach the daemon's peer index too, or status
				// reads would disagree with the rooms the peer is woken for.
				if (event.type === "membership") {
					const record = peers.get(event.agent);
					if (record) peers.set(event.agent, { ...record, rooms: event.rooms });
				}
				consoleApi?.emit(event);
			},
			// T-505: definitions re-read per delivery; a fingerprint mismatch
			// rebuilds through this seam rather than reusing stale policy.
			peers: store,
			respawn: async ({ peerName, definition, previousFingerprint }) => {
				log(
					`rebuilding ${peerName}: definition changed (was ${previousFingerprint.slice(0, 12)}…)`,
				);
				const controlToken = mintControlToken();
				const previous = db
					.listAgents()
					.find((agent) => agent.name === peerName);
				const cwd = definition.workspace ?? previous?.cwd ?? projectDir;
				const scopedGateway = usesDefaultRpcWorker
					? await inferenceGatewayFor(
							peerName,
							definition,
							credentialIdsFor(
								peers.get(peerName)?.accountId ?? accountIdFor(definition),
							),
						)
					: undefined;
				let fresh: SupervisedWorker &
					Partial<Pick<WorkerHandle, "sandboxed" | "fingerprint" | "pid">>;
				try {
					fresh = recordRuns(
						await workerFactory({
							peer: definition,
							cwd,
							agentDir,
							rootDir: join(stateDir, "workers", peerName),
							discoveredAgentNames,
							inferenceGateway: scopedGateway ?? {
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
							...modelOverrideFor(definition),
						}),
						scopedGateway,
					);
				} catch (error) {
					if (scopedGateway)
						await closeInferenceGateway(peerName, scopedGateway);
					throw error;
				}
				activateControlToken(peerName, controlToken);
				// The supervisor swaps its own Peer record on return; the daemon's
				// parallel map backs status/stop, so it must point at the live
				// worker too.
				const record = peers.get(peerName);
				if (record) peers.set(peerName, { ...record, worker: fresh });
				markAgentRuntime(peerName, fresh.state, fresh.pid ?? null);
				if (previous)
					db.upsertAgent({
						...previous,
						cwd,
						status: fresh.state,
						workerPid: fresh.pid ?? null,
					});
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

		// Before the listing, so the seeded peers boot with everyone else. The
		// real launcher asks for this; a harness boots only what it wrote.
		const storeRoots = resolvePeerStoreRoots({ agentDir, projectDir });
		if (options.seedDefaultPeers === true) {
			await seedDefaultPeers({ userRoot: storeRoots.user, log });
		}
		// What a peer with no `model:` runs on. Resolved once: it is the
		// operator's OMP default, and a change to it takes effect on the next
		// spawn, which is also when a definition edit takes effect.
		const defaultModel =
			options.defaultModel ?? (await resolveDefaultModel(agentDir));
		log(
			defaultModel === undefined
				? "default model: none (OMP has no provider-qualified default role)"
				: `default model: ${defaultModel}`,
		);
		/** The definition's model, or the daemon default it falls back to. */
		const modelFor = (definition: PeerDefinition): string | undefined => {
			const declared = Array.isArray(definition.model)
				? definition.model[0]
				: definition.model;
			return typeof declared === "string" && declared.trim().length > 0
				? declared
				: defaultModel;
		};
		/** The override handed to the worker factory: only when the peer has none. */
		const modelOverrideFor = (
			definition: PeerDefinition,
		): { model?: string } => {
			const declared = Array.isArray(definition.model)
				? definition.model[0]
				: definition.model;
			return typeof declared === "string" && declared.trim().length > 0
				? {}
				: defaultModel === undefined
					? {}
					: { model: defaultModel };
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
			ownedGateway?: ScopedInferenceGateway,
		): SupervisedWorker &
			Partial<
				Pick<WorkerHandle, "sandboxed" | "fingerprint" | "pid" | "stderr">
			> => ({
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
			// And the buffered stderr: `logs_tail` reads it off this wrapper,
			// so dropping it made every worker log tail an empty string with no
			// error — the debugging surface answered "nothing here" for every
			// peer, however much it had written.
			get stderr() {
				return (worker as Partial<Pick<WorkerHandle, "stderr">>).stderr;
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
				try {
					await worker.stop();
				} finally {
					if (ownedGateway)
						await closeInferenceGateway(worker.name, ownedGateway);
				}
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
		const spawnPeer = (
			name: string,
			options: { parent?: string; cwd?: string } = {},
		): Promise<AgentSpawnResult> => {
			if (shuttingDown)
				return Promise.reject(new Error("Daemon is shutting down"));
			const inFlight = spawnInFlight.get(name);
			if (inFlight) {
				if (inFlight.parent !== options.parent) {
					return Promise.reject(
						new InvalidParamsError(
							"parent",
							`Peer ${name} is already starting with a different parent`,
						),
					);
				}
				return inFlight.promise;
			}
			const promise = spawnPeerInner(name, options).finally(() => {
				if (spawnInFlight.get(name)?.promise === promise)
					spawnInFlight.delete(name);
			});
			spawnInFlight.set(name, { parent: options.parent, promise });
			return promise;
		};
		const spawnPeerInner = async (
			name: string,
			options: { parent?: string; cwd?: string } = {},
		): Promise<AgentSpawnResult> => {
			const definition = await store.get(name);
			if (!definition) {
				throw new InvalidParamsError("name", `Unknown peer: ${name}`);
			}
			definitions.set(name, definition);

			// Parentage is validated before anything is built, and before the
			// idempotence shortcut below: an impossible edge must be refused on
			// its own terms rather than answered "already running", which would
			// report success for a spawn that never happened.
			const parent = options.parent ?? parents.get(name);
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
			if (shuttingDown) throw new Error("Daemon is shutting down");

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
			const roomWorkspaces = [
				...new Set(
					peerRooms.flatMap((room) => {
						const workspace = knownRooms.get(room)?.workspace;
						return workspace ? [workspace] : [];
					}),
				),
			];
			if (!definition.workspace && !options.cwd && roomWorkspaces.length > 1) {
				throw new InvalidParamsError(
					"workspace",
					"Subscribed channels have different workspaces. Set an explicit agent workspace before starting.",
				);
			}
			const cwd =
				definition.workspace ?? options.cwd ?? roomWorkspaces[0] ?? projectDir;

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
			const scopedGateway = usesDefaultRpcWorker
				? await inferenceGatewayFor(
						name,
						materialized,
						credentialIdsFor(accountId),
					)
				: undefined;
			let worker: SupervisedWorker &
				Partial<Pick<WorkerHandle, "sandboxed" | "fingerprint" | "pid">>;
			try {
				worker = recordRuns(
					await workerFactory({
						peer: materialized,
						cwd,
						agentDir,
						rootDir: join(stateDir, "workers", name),
						discoveredAgentNames,
						inferenceGateway: scopedGateway ?? {
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
						...modelOverrideFor(definition),
					}),
					scopedGateway,
				);
			} catch (error) {
				if (scopedGateway) await closeInferenceGateway(name, scopedGateway);
				throw error;
			}
			activateControlToken(name, controlToken);

			for (const room of peerRooms) await ensureRoom(room);

			const accountConfig = accountConfigs.get(accountId) ?? {
				mode:
					definition.autonomy?.budgetUsd === undefined
						? ("subscription" as const)
						: ("metered" as const),
				budgetUsd: definition.autonomy?.budgetUsd,
			};
			accountConfigs.set(accountId, accountConfig);

			await supervisor.register({
				worker,
				accountId,
				mode: accountConfig.mode,
				rooms: peerRooms,
				wake: definition.wake,
				budgetUsd: accountConfig.budgetUsd,
			});

			if (parent === undefined) parents.delete(name);
			else parents.set(name, parent);

			peers.set(name, {
				worker,
				accountId,
				// The model it actually runs on: the daemon default when the
				// definition declares none, so status names something real.
				model: modelFor(definition),
				rooms: peerRooms,
				...(parent === undefined ? {} : { parent }),
			});
			// This peer is running; whatever stopped it last time is history.
			startFailures.delete(name);
			db.upsertAgent({
				name,
				definitionPath: definitionPathFor(definition),
				status: worker.state,
				workerPid: worker.pid ?? null,
				cwd,
				startedAt: now(),
				parent: parent ?? null,
			});
			consoleApi?.emit({ type: "agent", agent: name, state: worker.state });
			registerDeclaredSchedules(definition);
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
			const pending = spawnInFlight.get(name);
			if (pending) await pending.promise.catch(() => undefined);
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
				} finally {
					await closeInferenceGateway(peerName);
				}
				revokeControlToken(peerName);
				// The supervisor and the account registry stop counting this
				// peer here. Leaving it registered kept a dead agent's run on
				// the account, so park and resume did their arithmetic over
				// agents that no longer existed.
				supervisor.unregister(peerName);
				markAgentRuntime(peerName, "stopped", null);
				// After the stop and the persisted row, per peer rather than
				// once for the subtree: a cascade stops several agents and the
				// console has to learn about each of them, not just the one
				// the operator named.
				consoleApi?.emit({
					type: "agent",
					agent: peerName,
					state: "stopped",
				});
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
					// A schedule with no room has already done everything it is
					// going to do — the next-fire row is its whole commit — so
					// the frame is owed here. Reporting it is the point: a
					// silent no-op looks identical to a timer that never ran.
					if (room === undefined) {
						consoleApi?.emit({
							type: "schedule",
							agent: peer.name,
							phase: "fired",
						});
						return;
					}
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
					// After the post commits, never before: a frame published
					// ahead of a post that then throws announces a firing the
					// peer never saw.
					consoleApi?.emit({
						type: "schedule",
						agent: peer.name,
						phase: "fired",
					});
				},
			});
			// After the timer exists and the row is persisted: an "armed" frame
			// published ahead of either would name a schedule a restart would
			// not find.
			consoleApi?.emit({ type: "schedule", agent: peer.name, phase: "armed" });
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

		/**
		 * Why a peer that should be running is not, keyed by name.
		 *
		 * A start that throws is caught so one bad definition cannot take the
		 * daemon down with it — but until this map existed the only record was a
		 * line in the daemon's own stderr, and the peer was simply missing from
		 * `status` with no way to ask why from the TUI, the CLI, or the console.
		 * Cleared by the next start that succeeds.
		 */
		const startFailures = new Map<string, string>();

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

		const registerDeclaredSchedules = (definition: PeerDefinition): void => {
			const declaredSchedules = definition.schedules ?? [];
			for (let index = 0; index < declaredSchedules.length; index++) {
				const schedule = declaredSchedules[index];
				if (!schedule) continue;
				const id = `${definition.name}:schedule:${index}`;
				if (
					(schedules.get(id)?.enabled ?? persisted.get(id)?.enabled) === false
				) {
					// Restored as the operator left it: listed, but with no timer and
					// no next fire, which is what disarmed means everywhere else.
					scheduler.remove(id);
					db.setScheduleNextFire(id, null);
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
				const enabled =
					schedules.get(id)?.enabled ?? persisted.get(id)?.enabled ?? true;
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
		};

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
				const reason = error instanceof Error ? error.message : String(error);
				log(`peer ${definition.name} failed to start: ${reason}`);
				startFailures.set(definition.name, reason);
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

		/**
		 * Close once, and let every caller await that same close.
		 *
		 * Memoized on the promise rather than on a `closed` flag: a second
		 * caller — the postmortem cleanup, a racing `daemon_stop`, a test — must
		 * not be told shutdown is done while the first call is still tearing
		 * things down. It is also what makes the close `daemon_stop` schedules
		 * joinable: that close belongs to no caller, so anyone who needs to wait
		 * for it simply calls `close()` and gets the shutdown already running.
		 */
		let closing: Promise<void> | undefined;
		const closeDaemon = (): Promise<void> => {
			shuttingDown = true;
			closing ??= (async () => await (await assembled.promise)())();
			return closing;
		};

		/**
		 * Acknowledge a stop, then close on a later macrotask.
		 *
		 * The deferral is the contract: closing tears down the control socket,
		 * so awaiting it here would sever the connection this very answer has to
		 * travel back on, and the operator who asked the daemon to stop would
		 * see a dead socket instead of a confirmation.
		 *
		 * Idempotent by way of `closeDaemon`, which is already guarded — a
		 * second request gets the same acknowledgement rather than a refusal for
		 * arriving during a shutdown it also asked for.
		 */
		let stopScheduled = false;
		const requestDaemonStop = async (): Promise<DaemonStopResult> => {
			if (!(await ownsPidfile(pidPath))) {
				throw new InvalidParamsError(
					"params",
					`Refusing to stop: pidfile ${pidPath} no longer names this process (pid ${process.pid})`,
				);
			}
			shuttingDown = true;
			if (!stopScheduled) {
				stopScheduled = true;
				setTimeout(() => {
					void closeDaemon();
				}, 0);
			}
			return { stopping: true, pid: process.pid };
		};

		/**
		 * Read the daemon's own stderr at call time, never cached: this process
		 * appends to that file through its own stderr, so anything held would
		 * be stale by the line that made someone ask for it.
		 */
		const daemonLog = async (): Promise<string> => {
			try {
				return await readFile(logPath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
				throw error;
			}
		};

		/**
		 * Kill, inject, logs-tail, and bump — composed once, here.
		 *
		 * This is the single construction site the extraction exists for: the
		 * control socket and the console API are both handed *this* object, so
		 * a kill from the browser and a kill from the CLI are the same code
		 * path with the same cascade semantics (T-1605).
		 */
		const operations = createOperations({
			rooms,
			supervisor,
			peers,
			killPeer,
			bumpAccount,
			daemonLog,
		});

		/**
		 * Rewrite the credential files this daemon advertises itself with, if
		 * they are gone.
		 *
		 * The token is the one minted at boot, held in memory: rewriting the
		 * same bytes keeps every client that already has it working, where
		 * minting a fresh one would revoke a credential nobody asked to rotate.
		 * A file that is still there is left untouched, mode included — the
		 * operator may have tightened it, and `verifySecretMode` is the thing
		 * that judges it.
		 */
		const ensureCredentials = async (): Promise<void> => {
			const restore = async (file: string, contents: string): Promise<void> => {
				const path = join(stateDir, file);
				try {
					await stat(path);
					return;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await writeFile(path, contents, {
					encoding: "utf8",
					mode: TOKEN_MODE,
				});
				// umask can mask bits off the create mode; set them explicitly,
				// exactly as `loadSecret` does.
				await chmod(path, TOKEN_MODE);
				log(`restored missing ${file}`);
			};

			try {
				await restore(TOKEN_FILE, operatorToken);
				if (consoleUrl !== undefined) {
					await restore("console-url", consoleUrl);
				}
			} catch (error) {
				// Healing is best effort: a state directory this daemon can no
				// longer write to is a real problem, but not one worth failing
				// every RPC over.
				log(`restoring credential files failed: ${String(error)}`);
			}
		};

		/**
		 * The picker's catalog: what every credential the daemon holds can
		 * route to, plus the default a model-less peer runs on. A token scoped
		 * to the union of credentials, minted per call and revoked after, so
		 * the listing never leaves a long-lived bearer behind.
		 */
		const listPresets = async (): Promise<PresetsListResult> => ({
			presets: await listShippedPresets(),
		});
		const listModels = async (): Promise<ModelsListResult> => {
			const credentialIds = [
				...new Set([...providerCredentials.values()].flat()),
			];
			const issued = gateway.issueWorkerToken({
				workerId: "models-list",
				credentialIds,
			});
			try {
				const models = await listRoutableModels({
					brokerUrl: gateway.url,
					brokerToken: issued.token,
					modelsPath: join(agentDir, "models.yml"),
					// The daemon's injectable upstream transport is typed narrower than
					// the global `fetch` the registry wants; only a test injects one.
					...(options.fetchUpstream === undefined
						? {}
						: { fetch: options.fetchUpstream as unknown as typeof fetch }),
				});
				return {
					models,
					...(defaultModel === undefined
						? {}
						: {
								default: defaultModel,
								defaultRoutable: models.some(
									(model) => `${model.provider}/${model.id}` === defaultModel,
								),
							}),
				};
			} finally {
				gateway.revokeWorkerToken?.(issued.token);
			}
		};

		const context: DaemonContext = {
			rooms,
			plans,
			onPlanChanged: (room) => consoleApi?.publish({ type: "plan", room }),
			supervisor,
			peers,
			knownRooms,
			schedules,
			orphans,
			startFailures,
			store,
			writeDefinition,
			startedAt: now(),
			version: PACKAGE_VERSION,
			ensureCredentials,
			now,
			ensureRoom,
			spawnPeer,
			killPeer,
			armSchedule,
			bumpAccount,
			listModels,
			listPresets,
			setMembership,
			requestDaemonStop,
			daemonLog,
			operations,
		};

		const socket = await startControlSocket({
			socketPath,
			context,
			identities,
			// Remote mode is a property of the daemon, not of the console alone:
			// the control socket is composed with the same flag the console API
			// gets, so the listener enforces a value threaded here rather than
			// re-derived from the environment. On this socket the flag makes
			// the operator surface require the operator token specifically
			// (ADR-012 (a)); the bearer requirement itself is unconditional in
			// both modes, and a worker's scoped token keeps its own surface in
			// both, which is clause (b) and what T-1204 builds parentage on.
			remoteMode,
		});
		started.push(() => socket.close());

		/**
		 * Serve the console, unless the operator asked for a headless daemon.
		 *
		 * Serving it is the point of the surface, so it is on by default; the
		 * kill switch exists for a daemon nobody is meant to look at. Loopback URLs
		 * carry the token; a configured external origin never does.
		 *
		 * Assigning `consoleApi` here — declared beside the supervisor — is
		 * what completes the transition feed: the supervisor's `emit` hook and
		 * the daemon's own `spawnPeer`, `killPeer`, and schedule emitters all
		 * read that binding on every call, so from this line on every one of
		 * those transitions reaches connected consoles.
		 */
		let consoleUrl: string | undefined;
		let consoleListenerUrl: string | undefined;
		if (consoleEnabled) {
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
				web,
				rooms,
				supervisor,
				peers,
				knownRooms,
				peerStore: store,
				ensureRoom,
				spawnPeer,
				listModels,
				listPresets,
				// The same object the control socket got, not a second copy.
				operations,
				token,
				// Loopback only, in every mode. Remote mode changes what a
				// request must carry, never where this listens (ADR-012); the
				// preflight above has already refused any attempt to move it.
				hostname: "127.0.0.1",
				port: consolePort,
				remoteMode,
				...(proxySecret === undefined ? {} : { proxySecret }),
			});
			const api = consoleApi;
			// Registered before anything below can throw, so a failed boot takes
			// the listener down with it rather than leaving a bound port.
			started.push(() => api.close());
			consoleListenerUrl = api.url;
			consoleUrl =
				externalConsoleOrigin ??
				`${api.url}/?token=${encodeURIComponent(token)}`;
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

		assembled.resolve(async () => {
			// The usage loop first: it fetches through the gateway and posts
			// through the supervisor, so a poll in flight after either closes is a
			// call against a torn-down dependency. Await the in-flight tick, not
			// just the timer, before anything below tears those down.
			await stopUsageLoop();
			await stopAttachmentCleanup();

			/**
			 * Run one teardown step, and never let it cancel the rest.
			 *
			 * Shutdown is a sequence of independent releases, and an exception
			 * partway through used to abandon every step after it: a SQLite
			 * `disk I/O error` closing open runs left the database handle, the
			 * gateways, the pidfile, and the socket file all behind, so the next
			 * boot met a pidfile it could not claim and debris it had to clean.
			 * Mirrors the `started` unwind on the failed-boot path below, which
			 * has always run every entry regardless.
			 */
			const step = async (
				label: string,
				body: () => void | Promise<void>,
			): Promise<void> => {
				try {
					await body();
				} catch (error) {
					log(`shutdown step ${label} failed: ${String(error)}`);
				}
			};

			// Reverse order: the console and the socket first, so no new request
			// arrives; then the workers, then the machinery they depend on, and
			// only then the files that advertise this daemon's existence.
			//
			// The console goes before the room store on purpose: its live feed
			// polls that store while a browser is connected, and closing the
			// database under a running poller is a query against a closed
			// handle.
			await step("console", async () => await consoleApi?.close());
			await step("control socket", async () => await socket.close());
			await step("chats", async () => await chats.close());
			await step("plans", () => plans.close());
			await step("supervisor", async () => await supervisor.settled());
			await Promise.all(
				[...spawnInFlight.values()].map(({ promise }) =>
					promise.catch((error) =>
						log(`starting peer during shutdown: ${String(error)}`),
					),
				),
			);
			for (const record of peers.values()) {
				try {
					await record.worker.stop();
				} catch (error) {
					log(`stopping ${record.worker.name}: ${String(error)}`);
				} finally {
					await closeInferenceGateway(record.worker.name);
				}
			}
			await step("scheduler", () => scheduler.stop());

			// A turn still in flight belongs to a process about to stop
			// existing. Closing its row as interrupted is the last write; after
			// it, `recording` is off so a late completion cannot reopen the
			// question — or touch a closed database.
			await step("interrupt open runs", () => {
				const interrupted = db.interruptOpenRuns(now());
				if (interrupted > 0) {
					log(`closed ${interrupted} interrupted run(s) at shutdown`);
				}
			});
			await step("mark agents stopped", () => {
				for (const name of peers.keys()) {
					markAgentRuntime(name, "stopped", null);
				}
			});
			recording = false;
			await step("database", () => db.close());

			for (const workerId of [...inferenceGateways.keys()]) {
				await step(
					`inference gateway ${workerId}`,
					async () => await closeInferenceGateway(workerId),
				);
			}
			await step("credential gateway", async () => await gateway.close());
			await step("rooms", async () => await rooms.close());
			await step("broker", async () => await hosting.close());
			// Re-checked here, not just where the stop was requested: the close
			// `daemon_stop` schedules runs a macrotask after its ack, and a
			// successor daemon can claim the pidfile inside that window. An
			// unconditional unlink would delete the new owner's lock.
			await step("pidfile", async () => {
				if (await ownsPidfile(pidPath)) {
					await rm(pidPath, { force: true });
				}
			});
			await step("socket file", async () => {
				await rm(socketPath, { force: true });
			});
			await step("console url", async () => {
				await rm(join(stateDir, "console-url"), { force: true });
			});
		});

		return {
			socketPath,
			pidPath,
			logPath,
			...(consoleUrl === undefined ? {} : { consoleUrl }),
			...(consoleListenerUrl === undefined ? {} : { consoleListenerUrl }),
			close: closeDaemon,
		};
	} catch (error) {
		// A stop that arrived mid-boot is parked on `assembled`; this boot is
		// unwinding `started` itself, so release it rather than leave that
		// caller waiting on a teardown which is never going to be published.
		assembled.reject(error);
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
export async function runDaemon(workerBackend: WorkerBackend): Promise<void> {
	const announce = (url: string | undefined): void => {
		process.stdout.write(`${url ?? ""}\n`);
		process.stdout.end();
	};

	let handle: DaemonHandle;
	try {
		handle = await bootDaemon({
			inProcessWorkers: workerBackend === "in-process",
			seedDefaultPeers: true,
			logger: (message) => {
				process.stderr.write(`${message}\n`);
			},
			// The launcher holds this pipe open waiting for exactly this line. It
			// is the only thing ever written to stdout, and stdout is closed
			// straight after — including when there is no console to announce —
			// so the launcher stops waiting instead of hanging for the daemon's
			// lifetime.
			announce,
		});
	} catch (error) {
		if (!(error instanceof AlreadyRunningError)) throw error;
		// Not a failure: the operator asked for a daemon and this profile has
		// one. Announce the live daemon's console URL so the launcher — and
		// through it the TUI's session start — sees a ready daemon instead of
		// waiting out a child that died, then reporting "exited before
		// readiness" for a socket that was answering the whole time.
		process.stderr.write(`${error.message}\n`);
		const stateDir = join(
			process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
			STATE_DIR,
		);
		let consoleUrl: string | undefined;
		try {
			const stored = (
				await readFile(join(stateDir, "console-url"), "utf8")
			).trim();
			if (stored.length > 0) consoleUrl = stored;
		} catch (readError) {
			if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw readError;
			}
		}
		announce(consoleUrl);
		return;
	}
	postmortem.register("oh-my-agent-daemon", () => handle.close());
}
