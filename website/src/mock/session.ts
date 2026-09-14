import { DEMO_TOKEN } from "./demoToken";

/** The key the real console reads its operator token from. */
export const TOKEN_STORAGE_KEY = "oh-my-agent.operator-token";

/** Puts the demo token where the console expects an operator token. */
export function ensureDemoSession(): void {
	try {
		sessionStorage.setItem(TOKEN_STORAGE_KEY, DEMO_TOKEN);
	} catch {
		// Storage can be unavailable; every API call then answers 401 and the console shows it.
	}
}
