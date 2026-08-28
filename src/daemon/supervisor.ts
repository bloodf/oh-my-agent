/**
 * Purpose: The seam that makes peers autonomous (§4.3, §9.4). It subscribes a
 * peer to its rooms, applies room and mention wake filters, delivers pending
 * messages as one batched turn, parks the worker when its account runs out of
 * quota, and resumes it when the armed timer fires so nothing outside this
 * module has to choreograph `pendingForAgent` → wake → prompt → `markRead`.
 *
 * Public API: `Supervisor`.
 *
 * Upstream deps: `./account-registry` (quota state + wake gating),
 * `./scheduler` (one-shot resume timers), `../rooms/store` (durable rooms).
 *
 * Downstream consumers: the daemon entry point and the TUI extension, which
 * post into rooms and read worker status.
 *
 * Failure modes: delivering to an unregistered peer throws — silently dropping
 * a message would look like an idle agent. A parked peer is never prompted;
 * its backlog waits in the room until the resume lands.
 *
 * Performance: per-peer delivery is serialized; it reads subscribed and mentioned pending messages, then writes acknowledgements after prompting.
 */

import type { RoomStore } from "../rooms/store";
import type { AccountMode } from "./account-registry";
import { AccountRegistry } from "./account-registry";
import type { QuotaBlock } from "./quota-state";
import type { Scheduler } from "./scheduler";

/** The slice of a worker the supervisor drives. */
export interface SupervisedWorker {
	readonly name: string;
	readonly state: "running" | "parked" | "stopped";
	prompt(message: string): Promise<void>;
	park(): Promise<void>;
	resume(): Promise<void>;
	stop(): Promise<void>;
}

export interface SupervisorDeps {
	rooms: RoomStore;
	scheduler: Scheduler;
	now: () => number;
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
			wake,
		});
		try {
			await this.#flushAccountNotifications(accountId);
		} catch (error) {
			this.deps.onError?.(error, accountId);
		}
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

		await peer.worker.prompt(batch);
		await this.#advanceCursors(peerName, pending);
		await this.deps.rooms.acknowledgeMentions(
			peerName,
			mentionPending.map((message) => message.id),
		);
		return true;
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
