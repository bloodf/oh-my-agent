"use client";

import App from "@/App";
import { initializeTheme } from "@/lib/theme";
import { ensureDemoSession, installDemoBackend } from "@site/mock";
import { useLayoutEffect } from "react";
import { DemoBanner } from "./DemoBanner";

// Order matters, as in the SPA's main.tsx: session and seams first, then theme, then mount.
ensureDemoSession();
installDemoBackend();
initializeTheme();

export function ConsoleApp() {
	// Client navigation away from /console keeps this module loaded, so the
	// seams come off on unmount and go back on if the demo mounts again. A
	// layout effect runs before the console's own effects open a socket.
	useLayoutEffect(() => installDemoBackend(), []);
	return (
		<>
			<DemoBanner />
			<App />
		</>
	);
}
