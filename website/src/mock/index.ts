/**
 * The console demo's in-browser daemon. Install before the real console
 * mounts; reset wipes persisted demo data and simulated activity.
 */
import { cancelActivity } from "./activity";
import { resetDemoData } from "./store";
import { installDemoTransport } from "./transport";

export { DEMO_TOKEN } from "./demoToken";
export { ensureDemoSession } from "./session";

/** Returns a function that puts the browser's own seams back. */
export function installDemoBackend(): () => void {
	return installDemoTransport();
}

export function resetDemo(): void {
	cancelActivity();
	resetDemoData();
}
