import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The daemon `console:dev` proxies to. `OMA_CONSOLE_URL` wins; otherwise the
 * URL the running daemon wrote to `<agent-dir>/oh-my-agent/console-url`; and
 * with neither, the documented fixed port `OMA_CONSOLE_PORT=50561`. Only the
 * origin is used: the operator token stays out of the proxy, and the page
 * still has to be opened with `?token=`.
 */
function daemonOrigin(): string {
	if (process.env.OMA_CONSOLE_URL) return new URL(process.env.OMA_CONSOLE_URL).origin;
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".omp", "agent");
	try {
		const written = readFileSync(
			path.join(agentDir, "oh-my-agent", "console-url"),
			"utf8",
		).trim();
		return new URL(written).origin;
	} catch {
		return "http://127.0.0.1:50561";
	}
}

const daemon = daemonOrigin();

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "oma-console-html",
			// Build only: the dev server must keep loading /src/main.tsx.
			apply: "build",
			transformIndexHtml(html) {
				return html
					.replace(
						/<script type="module"[^>]*src="\/[^"]+"[^>]*><\/script>/g,
						'<script type="module" src="/app.js"></script>',
					)
					.replace(
						/<link rel="stylesheet"[^>]*href="\/[^"]+"[^>]*>/g,
						'<link rel="stylesheet" href="/style.css" />',
					);
			},
		},
	],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
	publicDir: false,
	build: {
		outDir: path.resolve(import.meta.dirname, "../src/console"),
		emptyOutDir: true,
		cssCodeSplit: false,
		rollupOptions: {
			output: {
				entryFileNames: "app.js",
				// Lazily imported modules — mermaid and its diagram packs — are
				// sibling chunks the daemon serves by this exact shape, cached
				// immutably by hash. Everything else stays in app.js.
				chunkFileNames: "chunk-[name]-[hash].js",
				assetFileNames: (asset) =>
					asset.names?.[0]?.endsWith(".css")
						? "style.css"
						: "assets/[name][extname]",
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: daemon,
				changeOrigin: true,
				ws: true,
				// The daemon refuses a WebSocket whose Origin is not its own
				// loopback page. Behind this proxy the page is the dev server, so
				// present the daemon's origin on the handshake.
				configure: (proxy) => {
					proxy.on("proxyReqWs", (request) => {
						request.setHeader("Origin", daemon);
					});
				},
			},
		},
	},
});
