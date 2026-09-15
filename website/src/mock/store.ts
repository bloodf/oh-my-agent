/**
 * The mocked daemon's durable state: seeded once, replaced (never mutated)
 * on every write, and mirrored to localStorage under `oh-my-agent-demo:`.
 */
import { nextFire } from "./cron";
import { STATE_VERSION, seedState } from "./fixtures";
import type { DemoState } from "./types";

export const STORAGE_PREFIX = "oh-my-agent-demo:";
const STATE_KEY = `${STORAGE_PREFIX}state`;

type Stored = DemoState & { savedAt?: number };

let current: DemoState | undefined;

function storage(): Storage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const LISTS = ["channels", "messages", "agents", "plans", "schedules", "artifacts", "chats", "attachments"] as const;

/**
 * Enough of the shape that a browser holding state from an older demo build
 * reseeds instead of crashing the console. A version bump is the main guard;
 * this catches a fixture change nobody bumped for.
 */
export function isDemoState(value: unknown): value is Stored {
	if (!isObject(value) || value.version !== STATE_VERSION) return false;
	if (typeof value.seededAt !== "number" || typeof value.nextMessageId !== "number") return false;
	if (!LISTS.every((key) => Array.isArray(value[key]))) return false;
	if (!isObject(value.profile) || !isObject(value.profile.operator) || !isObject(value.profile.agents)) return false;
	const messages = value.messages as unknown[];
	if (!messages.every((m) => isObject(m) && typeof m.id === "number" && typeof m.room === "string" && typeof m.createdAt === "number" && Array.isArray(m.reactions))) return false;
	if (!(value.agents as unknown[]).every((a) => isObject(a) && typeof a.name === "string" && isObject(a.definition) && Array.isArray(a.logs))) return false;
	return (value.chats as unknown[]).every((c) => isObject(c) && isObject(c.info) && isObject(c.state) && Array.isArray(c.messages));
}

/**
 * Move every stored time forward by the time the tab was closed, so a return
 * visit still reads "5 minutes ago" and schedules still fire in the future.
 */
export function reanchor(state: DemoState, delta: number, now: number): DemoState {
	if (delta <= 0) return state;
	const shift = (t: number) => t + delta;
	return {
		...state,
		seededAt: shift(state.seededAt),
		messages: state.messages.map((m) => ({ ...m, createdAt: shift(m.createdAt) })),
		plans: state.plans.map((p) => ({ ...p, createdAt: shift(p.createdAt), updatedAt: shift(p.updatedAt) })),
		schedules: state.schedules.map((row) => ({
			...row,
			nextFireAt: row.cron ? nextFire(row.cron, now) : row.nextFireAt === null ? null : shift(row.nextFireAt),
		})),
		artifacts: state.artifacts.map((a) => ({ ...a, updatedAt: new Date(shift(Date.parse(a.updatedAt))).toISOString() })),
		chats: state.chats.map((c) => ({
			...c,
			info: { ...c.info, createdAt: shift(c.info.createdAt), updatedAt: shift(c.info.updatedAt) },
			state: { ...c.state, createdAt: shift(c.state.createdAt), updatedAt: shift(c.state.updatedAt) },
			messages: c.messages.map((m) => (typeof m.timestamp === "number" ? { ...m, timestamp: shift(m.timestamp) } : m)),
		})),
	};
}

function load(): DemoState {
	const now = Date.now();
	try {
		const raw = storage()?.getItem(STATE_KEY);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (isDemoState(parsed)) {
				const { savedAt, ...state } = parsed;
				return reanchor(state, typeof savedAt === "number" ? now - savedAt : 0, now);
			}
		}
	} catch {
		// Corrupt or unavailable storage reseeds below.
	}
	const seeded = seedState(now);
	persist(seeded);
	return seeded;
}

function persist(state: DemoState): void {
	try {
		storage()?.setItem(STATE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
	} catch {
		// Quota or private mode: the demo keeps working for this page.
	}
}

export function getState(): DemoState {
	current ??= load();
	return current;
}

/**
 * Apply one immutable update. `persist: false` keeps it in memory only, for
 * streaming ticks whose final write persists the whole reply at once.
 */
export function update(change: (state: DemoState) => DemoState, options: { persist?: boolean } = {}): DemoState {
	current = change(getState());
	if (options.persist !== false) persist(current);
	return current;
}

/** Forget every demo key; the next read seeds fresh data. */
export function resetDemoData(): void {
	const store = storage();
	if (store) {
		for (const key of Object.keys(store)) if (key.startsWith(STORAGE_PREFIX)) store.removeItem(key);
	}
	current = undefined;
}
