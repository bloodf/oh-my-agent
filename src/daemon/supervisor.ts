/**
 * Purpose: The seam that makes peers autonomous (§4.3, §9.4). It subscribes a
 * peer to its rooms, applies room and mention wake filters, delivers pending
 * messages as one batched turn, parks the worker when its account runs out of
 * quota, and resumes it when the armed timer fires so nothing outside this
 * module has to choreograph `pendingForAgent` → wake → prompt → `markRead`.
 * It also owns each peer's live membership: `resubscribe` re-reads the
 * definition and replaces the cached room set, so the console never reaches
 * into that set and it keeps exactly one writer.
 *
 * It also enforces §10.3: before any turn is handed to a worker, the peer's
 * definition is re-read from disk and its fingerprint compared with the one the
 * live worker was built from. A match reuses the worker; a mismatch stops it
 * and rebuilds through `SupervisorDeps.respawn` before delivering, so a
 * policy-changing edit never applies to a running process and no file mutates
 * under one. There is no hot-reload path.
 *
 * Public API: `Supervisor`, `SupervisedWorker`, `SupervisorDeps`,
 * `RespawnRequest`. Membership changes go through `Supervisor.resubscribe`.
 *
 * Upstream deps: `./account-registry` (quota state + wake gating),
 * `./scheduler` (one-shot resume timers), `../rooms/store` (durable rooms),
 * `./peer-store` (current on-disk definitions), `../shared/agent-definition`
 * (`fingerprintPeerDefinition`).
 *
 * Downstream consumers: the daemon entry point and the TUI extension, which
 * post into rooms and read worker status. The entry point owns materialization
 * and so supplies `respawn`; without it a stale peer holds rather than rebuilds.
 *
 * Failure modes: delivering to an unregistered peer throws — silently dropping
 * a message would look like an idle agent. A parked peer is never prompted;
 * its backlog waits in the room until the resume lands. A definition that is
 * missing, unreadable, or whose rebuild fails holds the peer's backlog and
 * reports through `onError` rather than throwing into delivery or waking the
 * peer on a superseded policy.
 *
 * Performance: per-peer delivery is serialized; it reads subscribed and mentioned pending messages, then writes acknowledgements after prompting. The staleness check re-reads the peer store once per delivered turn.
 */

import type { RoomStore } from "../rooms/store";
import type { PeerDefinition } from "../shared/agent-definition";
import { fingerprintPeerDefinition } from "../shared/agent-definition";
import type { AccountMode } from "./account-registry";
import { AccountRegistry } from "./account-registry";
import type { PeerStore } from "./peer-store";
import type { QuotaBlock } from "./quota-state";
import type { Scheduler } from "./scheduler";

/** The slice of a worker the supervisor drives. */
export interface SupervisedWorker {
	readonly name: string;
	readonly state: "running" | "parked" | "stopped";
	/**
	 * Fingerprint of the definition this worker was materialized from, when the
	 * handle exposes one. `WorkerHandle` always does; a wrapper that drops it
	 * leaves the supervisor unable to compare, and an unanswerable comparison
	 * reuses the worker rather than rebuilding it on every turn.
	 */
	readonly fingerprint?: string;
	prompt(message: string): Promise<void>;
	park(): Promise<void>;
	resume(): Promise<void>;
	stop(): Promise<void>;
}

/** What the daemon needs in order to rebuild one peer from current disk. */
export interface RespawnRequest {
	peerName: string;
	/** Definition as it now reads on disk, already parsed. */
	definition: PeerDefinition;
	/** Fingerprint the superseded worker was built from, for logging. */
	previousFingerprint: string;
}

export interface SupervisorDeps {
	rooms: RoomStore;
	scheduler: Scheduler;
	now: () => number;
	/**
	 * Definitions as they currently sit on disk. Supplied, every delivery
	 * re-reads the peer's definition and compares fingerprints; omitted, the
	 * staleness check is skipped entirely and delivery is unchanged.
	 */
	peers?: PeerStore;
	/**
	 * Re-materialize a peer and start a fresh session, returning the new
	 * worker. Constructed in the daemon entry point, which owns materialization
	 * and the credential gateway; the default refuses rather than pretending a
	 * rebuild happened.
	 */
	respawn?: (request: RespawnRequest) => Promise<SupervisedWorker>;
	/** Surfaced when a queued park/resume fails; the daemon must not strand. */
	onError?: (error: unknown, peerName: string) => void;
}

export interface RegisterPeerOptions {
	worker: SupervisedWorker;
	/** Account whose quota governs this peer. */
	accountId: string;
	mode: AccountMode;
	/** Configured dollar ceiling for a metered account. */
	budgetUsd?: number;
	/** Rooms the peer subscribes to, from its `rooms:` frontmatter. */
	rooms: string[];
	wake?: {
		mention?: boolean;
		rooms?: boolean;
	};
}

interface Peer {
	worker: SupervisedWorker;
	accountId: string;
	/** Rooms this peer subscribes to; a post elsewhere must not wake it. */
	rooms: Set<string>;
	/**
	 * Rooms the live worker's fingerprint was computed over.
	 *
	 * Membership is inside `fingerprintPeerDefinition`, but rooms never reach
	 * a worker — the materializer keeps every oh-my-agent extra in the daemon
	 * (materializer.ts:151-153). Holding the value the fingerprint was taken
	 * with lets the staleness check subtract membership back out and compare
	 * policy alone, so subscribing a peer to a channel does not restart it.
	 * It moves only when the worker is rebuilt, never when membership changes.
	 */
	fingerprintRooms: string[] | undefined;
	wake: NonNullable<RegisterPeerOptions["wake"]>;
}

export class Supervisor {
	readonly registry: AccountRegistry;
	#peers = new Map<string, Peer>();
	#accountConfigs = new Map<
		string,
		{ mode: AccountMode; budgetUsd: number | undefined }
	>();
	#heldNotifications = new Map<string, string[]>();
	/** In-flight resume work, so callers can await the autonomous path. */
	#inFlight = new Set<Promise<void>>();
	/** Serialize each peer's prompt and acknowledgement cycle. */
	#deliveries = new Map<string, Promise<boolean>>();
	/** Serialize held notification flushes per account. */
	#notificationFlushes = new Map<string, Promise<void>>();
	/** Peers already reported as unable to answer the staleness check. */
	#unfingerprinted = new Set<string>();

	constructor(private deps: SupervisorDeps) {
		this.registry = new AccountRegistry({
			scheduler: deps.scheduler,
			now: deps.now,
			onPark: (accountId, runIds) => {
				for (const runId of runIds) this.#track(this.#parkPeer(runId));
				const budget = this.#accountConfigs.get(accountId)?.budgetUsd;
				if (budget !== undefined) {
					this.#queueAccountNotification(
						accountId,
						`Metered account ${accountId} exhausted its $${budget} budget; a budget bump is required.`,
					);
				}
			},
			onResume: (accountId, runIds) => {
				this.#track(this.#resumeAccount(accountId, runIds));
			},
			onWarning: (accountId) => {
				const budget = this.#accountConfigs.get(accountId)?.budgetUsd;
				if (budget !== undefined) {
					this.#queueAccountNotification(
						accountId,
						`Metered account ${accountId} reached 80% of its $${budget} budget.`,
					);
				}
			},
			onWake: () => {},
		});
	}

	/** Resolve once every queued park/resume has settled. */
	async settled(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.all([...this.#inFlight]);
		}
	}

	#track(work: Promise<void>): void {
		const tracked = work.finally(() => {
			this.#inFlight.delete(tracked);
		});
		this.#inFlight.add(tracked);
	}

	async #parkPeer(runId: string): Promise<void> {
		const peer = this.#peers.get(runId);
		if (!peer) return;
		try {
			await peer.worker.park();
		} catch (error) {
			this.deps.onError?.(error, runId);
		}
	}

	async #resumePeer(runId: string): Promise<boolean> {
		const peer = this.#peers.get(runId);
		if (!peer) return false;
		try {
			await peer.worker.resume();
			return true;
		} catch (error) {
			this.deps.onError?.(error, runId);
			return false;
		}
	}

	async #resumeAccount(accountId: string, runIds: string[]): Promise<void> {
		const resumed: string[] = [];
		for (const runId of runIds) {
			if (await this.#resumePeer(runId)) resumed.push(runId);
		}

		if (this.#accountConfigs.get(accountId)?.budgetUsd !== undefined) {
			await this.#postAccountNotification(
				accountId,
				`Metered account ${accountId} resumed after its budget bump.`,
			);
		}

		for (const runId of resumed) {
			try {
				await this.deliver(runId);
			} catch (error) {
				this.deps.onError?.(error, runId);
			}
		}
	}

	async register(options: RegisterPeerOptions): Promise<void> {
		const { worker, accountId, mode, rooms, wake = {}, budgetUsd } = options;
		this.#validateAccountConfig(accountId, mode, budgetUsd);

		for (const room of rooms) {
			// The daemon owns room existence: a peer declaring a room in its
			// frontmatter should not fail to start because nobody created it.
			await this.deps.rooms.createRoom({
				id: room,
				kind: room.startsWith("@") ? "dm" : "channel",
			});
			await this.deps.rooms.subscribe(worker.name, room);
		}

		const existing = this.#validateAccountConfig(accountId, mode, budgetUsd);
		if (!existing) this.#accountConfigs.set(accountId, { mode, budgetUsd });
		this.registry.register(accountId, mode);
		this.registry.addRun(accountId, worker.name);
		this.#peers.set(worker.name, {
			worker,
			accountId,
			rooms: new Set(rooms),
			// The worker was materialized from the definition as it reads now,
			// so its fingerprint was taken over exactly these rooms.
			fingerprintRooms: rooms.length === 0 ? undefined : [...rooms],
			wake,
		});
		try {
			await this.#flushAccountNotifications(accountId);
		} catch (error) {
			this.deps.onError?.(error, accountId);
		}
	}

	/**
	 * Re-read a peer's subscribed rooms from its definition and apply them to
	 * the *running* peer.
	 *
	 * This is the whole reason membership is not a database write. `register`
	 * copies rooms into a private `Set` that `post()` filters against, so an
	 * edit that stopped at SQLite would leave a live agent deaf to its new
	 * channel and still woken by its old one. It is exposed as one operation,
	 * rather than a setter the console could call, so that cached set has
	 * exactly one writer: two writers to it is the defect this exists to
	 * avoid.
	 *
	 * Membership is read back from the definition on disk rather than taken as
	 * an argument, so the file and the live peer cannot disagree about what
	 * the operator asked for.
	 */
	async resubscribe(peerName: string): Promise<string[]> {
		const peer = this.#require(peerName);
		const store = this.deps.peers;
		if (!store) {
			throw new Error(
				`Cannot re-read membership for ${peerName}: no peer store is wired into the supervisor`,
			);
		}
		const definition = await store.get(peerName);
		if (!definition) {
			throw new Error(`Peer ${peerName} has no definition on disk`);
		}

		const rooms = definition.rooms ?? [];
		for (const room of rooms) {
			await this.deps.rooms.createRoom({
				id: room,
				kind: room.startsWith("@") ? "dm" : "channel",
			});
			await this.deps.rooms.subscribe(peerName, room);
		}
		// Replace rather than merge: a removal is a membership change too, and
		// merging would make leaving a channel impossible.
		peer.rooms = new Set(rooms);
		return [...rooms];
	}

	#validateAccountConfig(
		accountId: string,
		mode: AccountMode,
		budgetUsd: number | undefined,
	): { mode: AccountMode; budgetUsd: number | undefined } | undefined {
		if (mode === "metered" && budgetUsd === undefined) {
			// A metered account with no ceiling warns and parks against nothing;
			// refuse the incoherent state rather than silently never notifying.
			throw new Error(`Metered account without a budget: ${accountId}`);
		}
		const existing = this.#accountConfigs.get(accountId);
		if (
			existing &&
			(existing.mode !== mode || existing.budgetUsd !== budgetUsd)
		) {
			throw new Error(`Conflicting account configuration: ${accountId}`);
		}
		return existing;
	}

	#accountRoom(accountId: string): string | undefined {
		const rooms = new Set<string>();
		for (const peer of this.#peers.values()) {
			if (peer.accountId !== accountId) continue;
			for (const room of peer.rooms) rooms.add(room);
		}
		return [...rooms].sort()[0];
	}

	#queueAccountNotification(accountId: string, body: string): void {
		this.#track(
			this.#postAccountNotification(accountId, body).catch((error) => {
				this.deps.onError?.(error, accountId);
			}),
		);
	}

	async #postAccountNotification(
		accountId: string,
		body: string,
	): Promise<void> {
		const room = this.#accountRoom(accountId);
		if (!room) {
			const held = this.#heldNotifications.get(accountId) ?? [];
			held.push(body);
			this.#heldNotifications.set(accountId, held);
			this.deps.onError?.(
				new Error(`No subscribed room for account notification: ${accountId}`),
				accountId,
			);
			return;
		}
		await this.post({ room, author: "@system", body });
	}

	async #flushAccountNotifications(accountId: string): Promise<void> {
		const previous =
			this.#notificationFlushes.get(accountId) ?? Promise.resolve();
		const flush = previous
			.catch(() => {})
			.then(async () => {
				const held = this.#heldNotifications.get(accountId);
				if (!held || !this.#accountRoom(accountId)) return;
				while (held.length > 0) {
					await this.#postAccountNotification(accountId, held[0]);
					held.shift();
				}
				this.#heldNotifications.delete(accountId);
			});
		this.#notificationFlushes.set(accountId, flush);
		try {
			await flush;
		} finally {
			if (this.#notificationFlushes.get(accountId) === flush) {
				this.#notificationFlushes.delete(accountId);
			}
		}
	}

	/**
	 * Post into a room and deliver to every peer selected by its wake filters.
	 *
	 * This is the production trigger: nothing outside the supervisor has to
	 * notice a message and decide who should see it. Parked peers are skipped.
	 */
	async post(input: {
		room: string;
		author: string;
		body: string;
	}): Promise<string[]> {
		const message = await this.deps.rooms.post(input);

		const woken: string[] = [];
		for (const [name, peer] of this.#peers) {
			if (name === input.author) continue;
			const roomTrigger =
				peer.wake.rooms !== false && peer.rooms.has(input.room);
			const mentionTrigger =
				peer.wake.mention === true && message.mentions.includes(name);
			if (!roomTrigger && !mentionTrigger) continue;
			if (mentionTrigger && !peer.rooms.has(input.room)) {
				await this.deps.rooms.enqueueMention(name, message.id);
			}
			if (this.registry.isParked(peer.accountId)) continue;
			if (await this.deliver(name)) woken.push(name);
		}
		return woken;
	}

	/**
	 * Deliver every pending room message to a peer as one turn.
	 *
	 * Returns `false` without prompting when the peer is parked or has nothing
	 * waiting — burning a turn that will fail, or an empty one, helps nobody.
	 */
	async deliver(peerName: string): Promise<boolean> {
		const previous = this.#deliveries.get(peerName) ?? Promise.resolve(false);
		const delivery = previous
			.catch(() => false)
			.then(() => this.#deliver(peerName));
		this.#deliveries.set(peerName, delivery);
		try {
			return await delivery;
		} finally {
			if (this.#deliveries.get(peerName) === delivery) {
				this.#deliveries.delete(peerName);
			}
		}
	}

	async #deliver(peerName: string): Promise<boolean> {
		const peer = this.#require(peerName);
		if (!this.registry.wake(peer.accountId, peerName)) return false;

		const pending = await this.deps.rooms.pendingForAgent(peerName);
		const mentionPending =
			await this.deps.rooms.pendingMentionsForAgent(peerName);
		const seen = new Set<number>();
		// A peer's own posts must not wake it, or an agent that summarizes into
		// a room would re-wake itself forever.
		const rooms = pending
			// Membership is the cached set, not the subscription table: leaving
			// a room leaves its durable row behind (`RoomStore` has no
			// unsubscribe), so trusting `pendingForAgent` alone would smuggle a
			// left channel's backlog into the next turn the peer takes for any
			// other reason.
			.filter((entry) => peer.rooms.has(entry.room))
			.map((entry) => ({
				room: entry.room,
				messages: entry.messages.filter((message) => {
					if (message.author === peerName || seen.has(message.id)) return false;
					seen.add(message.id);
					return true;
				}),
			}))
			.filter((entry) => entry.messages.length > 0);
		for (const message of mentionPending) {
			if (message.author === peerName || seen.has(message.id)) continue;
			seen.add(message.id);
			const room = rooms.find((entry) => entry.room === message.room);
			if (room) room.messages.push(message);
			else rooms.push({ room: message.room, messages: [message] });
		}
		if (rooms.length === 0) {
			await this.#advanceCursors(peerName, pending);
			return false;
		}

		const batch = rooms
			.map((entry) =>
				entry.messages
					.map(
						(message) => `[${entry.room}] ${message.author}: ${message.body}`,
					)
					.join("\n"),
			)
			.join("\n");

		// §10.3: the definition on disk is re-read and compared here, so a turn
		// is never handled by a worker running a superseded policy. Held rather
		// than thrown — a rebuild that cannot happen leaves the backlog pending.
		if (!(await this.#ensureFresh(peerName, peer))) return false;

		await peer.worker.prompt(batch);
		await this.#advanceCursors(peerName, pending);
		await this.deps.rooms.acknowledgeMentions(
			peerName,
			mentionPending.map((message) => message.id),
		);
		return true;
	}

	/**
	 * Recompute the peer's fingerprint from current disk and rebuild on a
	 * mismatch. Returns whether the peer may now be prompted.
	 *
	 * The comparison must re-read the store rather than re-hash the definition
	 * the worker was built from: a fingerprint recomputed from the in-memory
	 * copy can never differ from itself, which is exactly the check that looks
	 * like it works and never fires.
	 *
	 * `fingerprintPeerDefinition` hashes the parsed definition's semantic
	 * fields, so reformatting a file — reordered keys, changed whitespace —
	 * produces the same fingerprint and reuses the live session.
	 */
	async #ensureFresh(peerName: string, peer: Peer): Promise<boolean> {
		const store = this.deps.peers;
		const current = peer.worker.fingerprint;
		if (!store) return true;
		if (current === undefined) {
			// A store is configured, so staleness was asked for, but this worker
			// cannot answer. `WorkerHandle` always carries a fingerprint, so the
			// cause is a wrapper that dropped it — report it once rather than
			// letting the whole check quietly never fire. Delivery continues:
			// holding every turn forever is worse than the check being absent.
			if (!this.#unfingerprinted.has(peerName)) {
				this.#unfingerprinted.add(peerName);
				this.deps.onError?.(
					new Error(
						`Peer ${peerName} exposes no fingerprint; the definition staleness check cannot run for it`,
					),
					peerName,
				);
			}
			return true;
		}

		let definition: PeerDefinition | undefined;
		try {
			definition = await store.get(peerName);
		} catch (error) {
			this.deps.onError?.(error, peerName);
			return false;
		}
		if (!definition) {
			// The file is gone. Waking on the last known policy is the one
			// outcome staleness handling exists to prevent, so hold the backlog
			// and report instead of prompting or throwing into delivery.
			this.deps.onError?.(
				new Error(
					`Peer ${peerName} has no definition on disk; holding delivery rather than waking it on a stale policy`,
				),
				peerName,
			);
			return false;
		}

		// Compare policy, not membership. Rooms are inside the fingerprint but
		// never reach a worker — the materializer keeps every oh-my-agent extra
		// in the daemon (materializer.ts:151-153) — and membership is applied
		// live by `resubscribe`. Hashing the current definition with the rooms
		// the live worker's fingerprint was taken over subtracts membership
		// back out, so subscribing a peer to a channel does not restart it
		// while any other edit still does.
		const fingerprint = fingerprintPeerDefinition({
			...definition,
			rooms: peer.fingerprintRooms,
		});
		if (fingerprint === current) return true;

		try {
			// Stop first: §10.3 forbids hot reload, so the superseded process is
			// gone before its replacement's files are written.
			await peer.worker.stop();
			const replacement = await this.#respawn({
				peerName,
				definition,
				previousFingerprint: current,
			});
			peer.worker = replacement;
			// The replacement was built from the definition as it now reads, so
			// its fingerprint's membership baseline moves with it.
			peer.fingerprintRooms = definition.rooms;
			return true;
		} catch (error) {
			this.deps.onError?.(error, peerName);
			return false;
		}
	}

	async #respawn(request: RespawnRequest): Promise<SupervisedWorker> {
		const respawn = this.deps.respawn;
		if (!respawn) {
			throw new Error(
				`Cannot rebuild ${request.peerName}: respawn not wired into the supervisor`,
			);
		}
		return await respawn(request);
	}

	/** Update a metered account's configured ceiling, then reset its latch. */
	bumpBudget(accountId: string, budgetUsd: number, meter = 0): void {
		const config = this.#accountConfigs.get(accountId);
		if (!config) throw new Error(`Unknown account: ${accountId}`);
		if (config.mode !== "metered") {
			throw new Error(`Cannot bump subscription account: ${accountId}`);
		}
		this.registry.bumpBudget(accountId, meter);
		this.#accountConfigs.set(accountId, { ...config, budgetUsd });
	}

	/** Record a quota block; parking and the resume timer follow from it. */
	async applyBlock(accountId: string, block: QuotaBlock): Promise<void> {
		this.registry.applyBlock(accountId, block);
	}

	/** Mark everything the peer has now seen, including its own posts. */
	async #advanceCursors(
		peerName: string,
		pending: { room: string; messages: { id: number }[] }[],
	): Promise<void> {
		for (const entry of pending) {
			const last = entry.messages.at(-1);
			if (last) await this.deps.rooms.markRead(peerName, entry.room, last.id);
		}
	}

	#require(peerName: string): Peer {
		const peer = this.#peers.get(peerName);
		if (!peer) throw new Error(`Unknown peer: ${peerName}`);
		return peer;
	}
}
