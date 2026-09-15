/**
 * Resolve a Chrome for puppeteer-core: env override, then the puppeteer
 * cache (any version, any platform), then system installs. Shared so every
 * browser suite agrees on it.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveChrome(): string {
	const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	const cacheRoot = join(
		homedir(),
		".cache",
		"puppeteer",
		"chrome-headless-shell",
	);
	try {
		for (const version of readdirSync(cacheRoot).sort().reverse()) {
			const versionDir = join(cacheRoot, version);
			for (const sub of readdirSync(versionDir)) {
				const candidate = join(versionDir, sub, "chrome-headless-shell");
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// No puppeteer cache on this machine.
	}

	for (const candidate of [
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		"No Chrome found: set PUPPETEER_EXECUTABLE_PATH or run `bunx @puppeteer/browsers install chrome-headless-shell`",
	);
}
