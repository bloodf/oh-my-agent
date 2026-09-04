import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "oma-console-html",
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
				chunkFileNames: "app.js",
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
			"/api": "http://127.0.0.1:50561",
		},
	},
});
