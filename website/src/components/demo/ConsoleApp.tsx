"use client";

import App from "@/App";
import { initializeTheme } from "@/lib/theme";
import { ensureDemoSession, installDemoBackend } from "@site/mock";
import { DemoBanner } from "./DemoBanner";

declare global {
	interface Window {
		/** Chunk URL minter the daemon injects; Next bundles the chunks itself here. */
		__omaAsset?: (filename: string) => string;
	}
}

// Order matters, as in the SPA's main.tsx: session and seams first, then theme, then mount.
ensureDemoSession();
installDemoBackend();
window.__omaAsset ??= (filename: string) => `/${filename}`;
initializeTheme();

export function ConsoleApp() {
	return (
		<>
			<DemoBanner />
			<App />
		</>
	);
}
