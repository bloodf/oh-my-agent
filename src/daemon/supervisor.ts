/**
 * Purpose: The seam that makes peers autonomous (§4.3, §9.4). It subscribes a
 * peer to its rooms, delivers pending messages as one batched turn, parks the
 * worker when its account runs out of quota, and resumes it when the armed
 * timer fires — so nothing outside this module has to choreograph
 * `pendingForAgent` → wake → prompt → `markRead` by hand.
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
 * Performance: one room query per delivery; no polling loop of its own.
 */
import { AccountRegistry } from "./account-registry";
import type { AccountMode } from "./account-registry";
import type { QuotaBlock } from "./quota-state";
import type { Scheduler } from "./scheduler";
import type { RoomStore } from "../rooms/store";

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
	/** Rooms the peer subscribes to, from its `rooms:` frontmatter. */
	rooms: string[];
}

interface Peer {
	worker: SupervisedWorker;
	accountId: string;
	/** Rooms this peer subscribes to; a post elsewhere must not wake it. */
	rooms: Set<string>;
}

export class Supervisor {
	readonly registry: AccountRegistry;
	#peers = new Map<string, Peer>();
	/** In-flight resume work, so callers can await the autonomous path. */
	#inFlight = new Set<Promise<void>>();

	constructor(private deps: SupervisorDeps) {
		this.registry = new AccountRegistry({
			scheduler: deps.scheduler,
			now: deps.now,
			onPark: (_accountId, runIds) => {
				for (const runId of runIds) this.#track(this.#parkPeer(runId));
			},
			onResume: (_accountId, runIds) => {
				// Resuming must also deliver: nobody is watching, so a restarted
				// worker with a full room backlog would otherwise sit idle.
				for (const runId of runIds) this.#track(this.#resumePeer(runId));
			},
			onWarning: () => {},
			// Waking is what the registry gates; delivery is this module's job.
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

	async #resumePeer(runId: string): Promise<void> {
		const peer = this.#peers.get(runId);
		if (!peer) return;
		try {
			await peer.worker.resume();
			await this.deliver(runId);
		} catch (error) {
			// A failed resume must not strand the daemon; surface and move on.
			this.deps.onError?.(error, runId);
		}
	}

	async register(options: RegisterPeerOptions): Promise<void> {
		const { worker, accountId, mode, rooms } = options;
		this.registry.register(accountId, mode);
		this.registry.addRun(accountId, worker.name);
		this.#peers.set(worker.name, { worker, accountId, rooms: new Set(rooms) });

		for (const room of rooms) {
			// The daemon owns room existence: a peer declaring a room in its
			// frontmatter should not fail to start because nobody created it.
			await this.deps.rooms.createRoom({ id: room, kind: room.startsWith("@") ? "dm" : "channel" });
			await this.deps.rooms.subscribe(worker.name, room);
		}
	}

	/**
	 * Post into a room and deliver to every subscribed peer it wakes.
	 *
	 * This is the production trigger: nothing outside the supervisor has to
	 * notice a message and decide who should see it. Parked peers are skipped
	 * and pick the backlog up on resume.
	 */
	async post(input: { room: string; author: string; body: string }): Promise<string[]> {
		await this.deps.rooms.post(input);

		const woken: string[] = [];
		for (const [name, peer] of this.#peers) {
			// A peer's own post must not wake it, and neither should a room it
			// never subscribed to — `deliver` drains its whole backlog.
			if (name === input.author) continue;
			if (!peer.rooms.has(input.room)) continue;
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
		const peer = this.#require(peerName);
		if (!this.registry.wake(peer.accountId, peerName)) return false;

		const pending = await this.deps.rooms.pendingForAgent(peerName);
		// A peer's own posts must not wake it, or an agent that summarizes into
		// a room would re-wake itself forever.
		const rooms = pending
			.map((entry) => ({
				room: entry.room,
				messages: entry.messages.filter((message) => message.author !== peerName),
			}))
			.filter((entry) => entry.messages.length > 0);
		if (rooms.length === 0) {
			await this.#advanceCursors(peerName, pending);
			return false;
		}

		const batch = rooms
			.map((entry) =>
				entry.messages.map((message) => `[${entry.room}] ${message.author}: ${message.body}`).join("\n"),
			)
			.join("\n");

		await peer.worker.prompt(batch);
		await this.#advanceCursors(peerName, pending);
		return true;
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
