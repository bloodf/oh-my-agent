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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, postmortem } from "@oh-my-pi/pi-utils";

import { RoomStore } from "../rooms/store";
import type {
	Automation,
	PeerDefinition,
	Schedule,
} from "../shared/agent-definition";
import type {
	AgentSpawnResult,
	RoomInfo,
	ScheduleInfo,
} from "../shared/protocol";
import { startWorker } from "../worker/lifecycle";
import { resolveBrokerHosting } from "./boot";
import { startCredentialGateway } from "./credential-gateway";
import { materializeWorker } from "./materializer";
import { createPeerStore, resolvePeerStoreRoots } from "./peer-store";
import { nextCronTime, Scheduler } from "./scheduler";
import type { DaemonContext, PeerRecord, ScheduleRecord } from "./socket";
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
	/** Root for this worker's materialized synthetic user tree. */
	rootDir: string;
	/** Names the worker's deny-list is built against. */
	discoveredAgentNames: string[];
	/** Scoped per-worker credential endpoint; never the admin token. */
	inferenceGateway: { url: string; token: string };
	/** Raw markdown for each agent the peer names in `spawns:`. */
	sourceSpawnAgents: Record<string, string>;
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
}

export interface DaemonHandle {
	socketPath: string;
	pidPath: string;
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

/** The real worker path: materialize a synthetic root, then launch the child. */
const defaultWorkerFactory: WorkerFactory = async (options) => {
	const layout = await materializeWorker({
		rootDir: options.rootDir,
		parsedPeer: options.peer,
		discoveredAgentNames: options.discoveredAgentNames,
		inferenceGateway: options.inferenceGateway,
		// A peer's `spawns:` closure must be materialized alongside it, or
		// `materializeWorker` refuses to build the root at all.
		sourceSpawnAgents: options.sourceSpawnAgents,
	});
	return await startWorker({ peer: options.peer, layout, cwd: options.cwd });
};

export async function bootDaemon(
	options: BootDaemonOptions = {},
): Promise<DaemonHandle> {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const projectDir = options.projectDir ?? process.cwd();
	const workerFactory = options.workerFactory ?? defaultWorkerFactory;
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

		const gateway = await startCredentialGateway({
			upstreamUrl: hosting.url,
			adminToken: hosting.adminToken,
		});
		started.push(() => gateway.close());

		const rooms = await RoomStore.open(join(stateDir, "rooms.db"));
		started.push(() => rooms.close());

		const scheduler = new Scheduler();
		scheduler.start();
		started.push(async () => scheduler.stop());

		const supervisor = new Supervisor({
			rooms,
			scheduler,
			now,
			onError: (error, peerName) => log(`peer ${peerName}: ${String(error)}`),
		});

		const peers = new Map<string, PeerRecord>();
		const knownRooms = new Map<string, RoomInfo>();
		const schedules = new Map<string, ScheduleRecord>();
		const definitions = new Map<string, PeerDefinition>();

		const ensureRoom = async (id: string): Promise<void> => {
			if (knownRooms.has(id)) return;
			const kind = id.startsWith("@") ? "dm" : "channel";
			await rooms.createRoom({ id, kind });
			knownRooms.set(id, { id, kind, name: id });
		};

		const store = createPeerStore(
			resolvePeerStoreRoots({ agentDir, projectDir }),
		);
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

		/** Materialize, launch, and register one peer. Idempotent by name. */
		const spawnPeer = async (name: string): Promise<AgentSpawnResult> => {
			const existing = peers.get(name);
			if (existing && existing.worker.state !== "stopped") {
				return { name, state: existing.worker.state };
			}
			const definition = definitions.get(name);
			if (!definition) {
				throw new InvalidParamsError("name", `Unknown peer: ${name}`);
			}

			const accountId = accountIdFor(definition);
			const worker = await workerFactory({
				peer: definition,
				cwd: projectDir,
				rootDir: join(stateDir, "workers", name),
				discoveredAgentNames,
				inferenceGateway: {
					url: gateway.url,
					// Bound to no credential ids yet: the account-to-credential
					// mapping is T-506's, and an unbound token sees nothing rather
					// than everything.
					token: gateway.issueWorkerToken({
						workerId: name,
						credentialIds: [],
					}).token,
				},
				sourceSpawnAgents: await spawnSourcesFor(definition),
			});

			const peerRooms = definition.rooms ?? [];
			for (const room of peerRooms) await ensureRoom(room);

			await supervisor.register({
				worker,
				accountId,
				// A declared dollar cap is what makes an account metered (§9.4).
				mode:
					definition.autonomy?.budgetUsd === undefined
						? "subscription"
						: "metered",
				rooms: peerRooms,
			});

			peers.set(name, {
				worker,
				accountId,
				model: Array.isArray(definition.model)
					? definition.model[0]
					: definition.model,
				rooms: peerRooms,
			});
			return { name, state: worker.state };
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
			scheduler.add(id, {
				cron: schedule.cron,
				handler: async () => {
					record.nextFireAt = nextCronTime(schedule.cron, now());
					if (room === undefined) return;
					await ensureRoom(room);
					// Posting through the supervisor is what wakes the peer; writing
					// to the store directly would fire into an empty room.
					await supervisor.post({
						room,
						author: HUMAN_AUTHOR,
						body: schedule.prompt,
					});
				},
			});
		};

		for (const definition of definitions.values()) {
			try {
				await spawnPeer(definition.name);
			} catch (error) {
				// One peer that cannot start must not take the daemon with it: the
				// operator needs a running socket to see what failed and why.
				log(`peer ${definition.name} failed to start: ${String(error)}`);
				continue;
			}

			const declaredSchedules = definition.schedules ?? [];
			for (let index = 0; index < declaredSchedules.length; index++) {
				const schedule = declaredSchedules[index];
				if (schedule) armCron(definition, schedule, index);
			}

			// An automation carries no clock, so nothing is scheduled: it is listed
			// as a timeless entry until an event source exists to fire it.
			const declaredAutomations: Automation[] = definition.automations ?? [];
			for (let index = 0; index < declaredAutomations.length; index++) {
				const automation = declaredAutomations[index];
				if (!automation) continue;
				const id = `${definition.name}:automation:${index}`;
				schedules.set(id, {
					id,
					peer: definition.name,
					cron: null,
					action: `${automation.event}: ${automation.prompt}`,
					enabled: true,
					nextFireAt: null,
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
				}
			}

			return {
				id: record.id,
				cron: record.cron,
				action: record.action,
				nextFireAt: record.nextFireAt,
				enabled: record.enabled,
			};
		};

		const bumpAccount = async (accountId: string): Promise<string[]> => {
			const parkedBefore = [...peers]
				.filter(
					([, record]) =>
						record.accountId === accountId && record.worker.state === "parked",
				)
				.map(([name]) => name);

			// The registry takes a 0..1 meter, so a raised ceiling means spend is
			// now a smaller fraction of it — zero is the only value a bump can
			// assert without knowing the dollars already burned (T-506 owns those).
			supervisor.registry.register(accountId, "metered");
			supervisor.registry.bumpBudget(accountId, 0);
			await supervisor.settled();

			return parkedBefore.filter(
				(name) => peers.get(name)?.worker.state === "running",
			);
		};

		const context: DaemonContext = {
			rooms,
			supervisor,
			peers,
			knownRooms,
			schedules,
			startedAt: now(),
			now,
			ensureRoom,
			spawnPeer,
			armSchedule,
			bumpAccount,
		};

		const socket = await startControlSocket({ socketPath, context });
		started.push(() => socket.close());

		let closed = false;
		return {
			socketPath,
			pidPath,
			close: async () => {
				if (closed) return;
				closed = true;

				// Reverse order: the socket first, so no new request arrives; then
				// the workers, then the machinery they depend on, and only then the
				// files that advertise this daemon's existence.
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
				await gateway.close();
				await rooms.close();
				await hosting.close();
				await rm(pidPath, { force: true });
				await rm(socketPath, { force: true });
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
	});
	postmortem.register("oh-my-agent-daemon", () => handle.close());
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const verb = argv[0] ?? "daemon";
	if (verb !== "daemon") {
		process.stderr.write("Usage: omp-agent daemon\n");
		process.exit(2);
	}

	if (process.env[DETACHED_ENV] === "1") {
		await runDaemon();
	} else {
		// Surviving a closed terminal is the product's core claim, so the
		// launching process must not be the daemon: re-spawn detached, print
		// where to reach the child, and exit.
		const child = Bun.spawn({
			cmd: [process.execPath, import.meta.path, ...argv],
			env: { ...process.env, [DETACHED_ENV]: "1" },
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
		});
		child.unref();
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
		process.stdout.write(`${join(agentDir, STATE_DIR, "daemon.sock")}\n`);
		process.exit(0);
	}
}
