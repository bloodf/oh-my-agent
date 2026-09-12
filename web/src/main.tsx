import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initializeTheme } from "./lib/theme.ts";

declare global {
	interface Window {
		/** Chunk URL minter; the daemon injects the real one into index.html. */
		__omaAsset?: (filename: string) => string;
	}
}
// The dev server and a bare shell have no injected minter: fall back to the
// session's loopback token so lazy chunks still load.
window.__omaAsset ??= (filename) =>
	`/${filename}?token=${encodeURIComponent(sessionStorage.getItem("oh-my-agent.operator-token") ?? "")}`;

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
initializeTheme();
createRoot(root).render(<App />);
