/**
 * Purpose: Serve the console storybook on loopback. Production CSS is
 * mounted at /style.css so every story paints with the real tokens.
 *
 * Public API: `startStorybook(port?)`.
 *
 * Failure modes: unknown paths 404. This process never talks to the daemon.
 */
import { join } from "node:path";

const ROOT = import.meta.dir;
const STYLE = join(ROOT, "..", "..", "src", "console", "style.css");

const ROUTES: Record<string, { path: string; type: string }> = {
	"/": { path: join(ROOT, "index.html"), type: "text/html; charset=utf-8" },
	"/preview.html": {
		path: join(ROOT, "preview.html"),
		type: "text/html; charset=utf-8",
	},
	"/workshop.css": {
		path: join(ROOT, "workshop.css"),
		type: "text/css; charset=utf-8",
	},
	"/stories.js": {
		path: join(ROOT, "stories.js"),
		type: "text/javascript; charset=utf-8",
	},
	"/style.css": { path: STYLE, type: "text/css; charset=utf-8" },
};

export function startStorybook(port = 0): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const route = ROUTES[url.pathname];
			if (route === undefined) {
				return new Response("Not found", { status: 404 });
			}
			const file = Bun.file(route.path);
			if (!(await file.exists())) {
				return new Response("Not found", { status: 404 });
			}
			return new Response(file, {
				headers: { "content-type": route.type },
			});
		},
	});
}

if (import.meta.main) {
	const server = startStorybook(Number(process.env.PORT ?? 6006));
	process.stdout.write(`Console storybook ${server.url}\n`);
}
