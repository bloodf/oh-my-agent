/**
 * Purpose: Serve the built console plus its story catalog on loopback.
 * Public API: `startStorybook(port?)`.
 * Failure modes: unknown paths 404. This process never talks to the daemon.
 * Lazily built chunks (the storybook itself, mermaid) are served by the same
 * name shape the daemon allows, from the build output only.
 */
import { join } from "node:path";

const ROOT = import.meta.dir;
const CONSOLE = join(ROOT, "..", "..", "src", "console");

const ROUTES: Record<string, { path: string; type: string }> = {
	"/": { path: join(CONSOLE, "index.html"), type: "text/html; charset=utf-8" },
	"/index.html": {
		path: join(CONSOLE, "index.html"),
		type: "text/html; charset=utf-8",
	},
	"/preview.html": {
		path: join(ROOT, "preview.html"),
		type: "text/html; charset=utf-8",
	},
	"/catalog.html": {
		path: join(ROOT, "index.html"),
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
	"/app.js": {
		path: join(CONSOLE, "app.js"),
		type: "text/javascript; charset=utf-8",
	},
	"/style.css": {
		path: join(CONSOLE, "style.css"),
		type: "text/css; charset=utf-8",
	},
};

/** The daemon's chunk allowlist: a lazily imported module named by hash. */
const CHUNK_FILE = /^\/chunk-[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.js$/;

export function startStorybook(port = 0): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			// Browsers ask for a favicon on their own schedule; an empty answer
			// keeps that request from showing up as a console error in a story.
			if (url.pathname === "/favicon.ico") {
				return new Response(null, { status: 204 });
			}
			const route =
				ROUTES[url.pathname] ??
				(CHUNK_FILE.test(url.pathname)
					? {
							path: join(CONSOLE, url.pathname.slice(1)),
							type: "text/javascript; charset=utf-8",
						}
					: undefined);
			if (route === undefined) {
				return new Response("Not found", { status: 404 });
			}
			const file = Bun.file(route.path);
			if (!(await file.exists())) {
				return new Response("Not found", { status: 404 });
			}
			const body =
				url.pathname === "/" || url.pathname === "/index.html"
					? (await file.text()).replace(
							'<html lang="en"',
							'<html lang="en" data-storybook="true"',
						)
					: file;
			return new Response(body, {
				headers: { "content-type": route.type },
			});
		},
	});
}

if (import.meta.main) {
	const server = startStorybook(Number(process.env.PORT ?? 6006));
	process.stdout.write(
		`Console storybook ${new URL("/catalog.html", server.url)}\n`,
	);
}
