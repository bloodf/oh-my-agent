import type { ConsoleFrame } from "./types";

type Listener = (frame: ConsoleFrame) => void;

const listeners = new Set<Listener>();

/** Every open mocked `/api/events` socket subscribes here. */
export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function listenerCount(): number {
	return listeners.size;
}

/** Emit after the state change commits, as the daemon does. */
export function publish(frame: ConsoleFrame): void {
	for (const listener of listeners) listener(frame);
}
