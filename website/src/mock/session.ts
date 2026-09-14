import { DEMO_PASSWORD } from "./demoPassword";

/** The key the real console reads its operator token from. */
export const TOKEN_STORAGE_KEY = "oh-my-agent.operator-token";

export function isDemoAuthenticated(): boolean {
	try {
		return sessionStorage.getItem(TOKEN_STORAGE_KEY) === DEMO_PASSWORD;
	} catch {
		return false;
	}
}

export function signIn(password: string): boolean {
	if (password !== DEMO_PASSWORD) return false;
	sessionStorage.setItem(TOKEN_STORAGE_KEY, DEMO_PASSWORD);
	return true;
}

export function signOut(): void {
	try {
		sessionStorage.removeItem(TOKEN_STORAGE_KEY);
	} catch {
		// Storage can be unavailable; the guard still sends the visitor to login.
	}
}
