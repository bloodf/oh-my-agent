/**
 * The mocked daemon's durable state: seeded once, replaced (never mutated)
 * on every write, and mirrored to localStorage under `oh-my-agent-demo:`.
 */
import { STATE_VERSION, seedState } from "./fixtures";
import type { DemoState } from "./types";

export const STORAGE_PREFIX = "oh-my-agent-demo:";
const STATE_KEY = `${STORAGE_PREFIX}state`;

let current: DemoState | undefined;

function storage(): Storage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function load(): DemoState {
	try {
		const raw = storage()?.getItem(STATE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as DemoState;
			if (parsed.version === STATE_VERSION) return parsed;
		}
	} catch {
		// Corrupt or unavailable storage reseeds below.
	}
	const seeded = seedState(Date.now());
	persist(seeded);
	return seeded;
}

function persist(state: DemoState): void {
	try {
		storage()?.setItem(STATE_KEY, JSON.stringify(state));
	} catch {
		// Quota or private mode: the demo keeps working for this page.
	}
}

export function getState(): DemoState {
	current ??= load();
	return current;
}

/** Apply one immutable update and persist it. */
export function update(change: (state: DemoState) => DemoState): DemoState {
	current = change(getState());
	persist(current);
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
