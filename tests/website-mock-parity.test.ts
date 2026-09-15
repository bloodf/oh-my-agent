/**
 * The website's console demo mocks the daemon's console API in the browser
 * (website/src/mock). A route or frame the daemon gains, loses, or renames
 * has to reach the mock too, or the demo quietly shows a console that no
 * longer matches the product. This suite pins both sides: the route patterns
 * written in the daemon's sources, the table below, and the mock's own route
 * table, plus the frame types each side declares.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type DaemonRoute = {
	method: string;
	/** A concrete path the route answers. */
	sample: string;
	/** The literal or regex, as written in the daemon source, that serves it. */
	source: string;
	/** Why the demo's router does not serve it, when it does not. */
	unmocked?: string;
};

const CHANNEL_PLANS = String.raw`/^\/api\/channels\/([^/]+)\/plans(?:\/([^/]+))?$/`;
const CHAT = String.raw`/^\/api\/chats\/([^/]+)(?:\/(state|messages|models|model|prompt|abort))?$/`;
const AGENT_OPS = String.raw`/^\/api\/agents\/([^/]+)\/(kill|inject|logs)$/`;
const AGENT_ROOMS = String.raw`/^\/api\/agents\/([^/]+)\/rooms(?:\/([^/]+))?$/`;

/** Every console route in src/daemon/console-api.ts and src/daemon/web-routes.ts. */
const DAEMON_ROUTES: DaemonRoute[] = [
	{ method: "POST", sample: "/api/session", source: '"/api/session"' },
	{ method: "POST", sample: "/api/ws-ticket", source: '"/api/ws-ticket"' },
	{
		method: "GET",
		sample: "/api/events",
		source: '"/api/events"',
		unmocked:
			"a WebSocket upgrade; website/src/mock/transport.ts patches WebSocket for it",
	},
	{ method: "GET", sample: "/api/capabilities", source: '"/api/capabilities"' },
	{ method: "GET", sample: "/api/models", source: '"/api/models"' },
	{ method: "GET", sample: "/api/presets", source: '"/api/presets"' },
	{ method: "GET", sample: "/api/schedules", source: '"/api/schedules"' },
	{
		method: "PATCH",
		sample: "/api/schedules/x",
		source: String.raw`/^\/api\/schedules\/([^/]+)$/`,
	},
	{ method: "GET", sample: "/api/artifacts", source: '"/api/artifacts"' },
	{ method: "POST", sample: "/api/artifacts", source: '"/api/artifacts"' },
	{ method: "GET", sample: "/api/profile", source: '"/api/profile"' },
	{ method: "PUT", sample: "/api/profile", source: '"/api/profile"' },
	{ method: "GET", sample: "/api/agents", source: '"/api/agents"' },
	{ method: "POST", sample: "/api/agents", source: '"/api/agents"' },
	{
		method: "POST",
		sample: "/api/agents/x/start",
		source: String.raw`/^\/api\/agents\/([^/]+)\/start$/`,
	},
	{ method: "POST", sample: "/api/agents/x/kill", source: AGENT_OPS },
	{ method: "POST", sample: "/api/agents/x/inject", source: AGENT_OPS },
	{ method: "GET", sample: "/api/agents/x/logs", source: AGENT_OPS },
	{
		method: "POST",
		sample: "/api/accounts/x/bump",
		source: String.raw`/^\/api\/accounts\/([^/]+)\/bump$/`,
		unmocked: "the console has no caller since the Accounts tab was removed",
	},
	{ method: "POST", sample: "/api/agents/x/rooms", source: AGENT_ROOMS },
	{ method: "DELETE", sample: "/api/agents/x/rooms/%23r", source: AGENT_ROOMS },
	{
		method: "GET",
		sample: "/api/agents/x/definition",
		source: String.raw`/^\/api\/agents\/([^/]+)\/definition$/`,
	},
	{
		method: "PATCH",
		sample: "/api/agents/x",
		source: String.raw`/^\/api\/agents\/([^/]+)$/`,
	},
	{
		method: "POST",
		sample: "/api/messages/1/reactions/toggle",
		source: String.raw`/^\/api\/messages\/(\d+)\/reactions\/toggle$/`,
	},
	{ method: "GET", sample: "/api/channels", source: '"/api/channels"' },
	{ method: "POST", sample: "/api/channels", source: '"/api/channels"' },
	{
		method: "PATCH",
		sample: "/api/channels/%23r",
		source: String.raw`/^\/api\/channels\/([^/]+)$/`,
	},
	{
		method: "GET",
		sample: "/api/channels/%23r/messages",
		source: String.raw`/^\/api\/channels\/([^/]+)\/messages$/`,
	},
	{
		method: "POST",
		sample: "/api/channels/%23r/messages",
		source: String.raw`/^\/api\/channels\/([^/]+)\/messages$/`,
	},
	{ method: "GET", sample: "/api/channels/%23r/plans", source: CHANNEL_PLANS },
	{ method: "POST", sample: "/api/channels/%23r/plans", source: CHANNEL_PLANS },
	{
		method: "PATCH",
		sample: "/api/channels/%23r/plans/p",
		source: CHANNEL_PLANS,
	},
	{
		method: "GET",
		sample: "/api/workspace/files",
		source: '"/api/workspace/files"',
	},
	{
		method: "GET",
		sample: "/api/workspace/changes",
		source: '"/api/workspace/changes"',
	},
	{
		method: "GET",
		sample: "/api/workspace/diff",
		source: '"/api/workspace/diff"',
	},
	{ method: "GET", sample: "/api/attachments", source: '"/api/attachments"' },
	{ method: "POST", sample: "/api/attachments", source: '"/api/attachments"' },
	{
		method: "DELETE",
		sample: "/api/attachments/a",
		source: String.raw`/^\/api\/attachments\/([^/]+)$/`,
	},
	{ method: "GET", sample: "/api/chats", source: '"/api/chats"' },
	{ method: "POST", sample: "/api/chats", source: '"/api/chats"' },
	{ method: "DELETE", sample: "/api/chats/c", source: CHAT },
	{ method: "GET", sample: "/api/chats/c/state", source: CHAT },
	{ method: "GET", sample: "/api/chats/c/messages", source: CHAT },
	{ method: "GET", sample: "/api/chats/c/models", source: CHAT },
	{ method: "POST", sample: "/api/chats/c/model", source: CHAT },
	{ method: "POST", sample: "/api/chats/c/prompt", source: CHAT },
	{ method: "POST", sample: "/api/chats/c/abort", source: CHAT },
];

const DAEMON_SOURCES = [
	"src/daemon/console-api.ts",
	"src/daemon/web-routes.ts",
];

/** Exact `/api/...` path comparisons and `/^\/api\/...$/` regex literals, as written. */
function routePatternsIn(text: string): Set<string> {
	const found = new Set<string>();
	for (const match of text.matchAll(/(?:path|pathname) === ("\/api\/[^"]*")/g))
		found.add(match[1] as string);
	for (const match of text.matchAll(/\/\^\\\/api\\\/.*?\$\//g))
		found.add(match[0]);
	return found;
}

/** The `type: "..."` members of one exported union, read from its source text. */
function frameTypesIn(text: string, typeName: string): Set<string> {
	const start = text.indexOf(`export type ${typeName} =`);
	if (start < 0) throw new Error(`export type ${typeName} not found`);
	// The union ends at the first blank line (object members end in ";" too).
	const end = text.indexOf("\n\n", start);
	const block = text.slice(start, end < 0 ? undefined : end);
	return new Set(
		[...block.matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1] as string),
	);
}

type MockRoute = { method: string; pattern: RegExp };

async function mockRoutes(): Promise<MockRoute[]> {
	// Loaded at run time: the website is its own TypeScript program.
	const modulePath = join(ROOT, "website/src/mock/router.ts");
	const { ROUTES } = (await import(modulePath)) as { ROUTES: MockRoute[] };
	return ROUTES;
}

describe("website console demo parity with the daemon", () => {
	test("the route table lists every route pattern the daemon source serves", () => {
		const inSource = new Set(
			DAEMON_SOURCES.flatMap((path) => [...routePatternsIn(read(path))]),
		);
		const listed = new Set(DAEMON_ROUTES.map((route) => route.source));
		const unlisted = [...inSource].filter((source) => !listed.has(source));
		const stale = [...listed].filter((source) => !inSource.has(source));
		expect({ unlisted, stale }).toEqual({ unlisted: [], stale: [] });
	});

	test("the mock serves every daemon route and nothing the daemon does not", async () => {
		const routes = await mockRoutes();
		const missing = DAEMON_ROUTES.filter(
			(route) =>
				!route.unmocked &&
				!routes.some(
					(mock) =>
						mock.method === route.method && mock.pattern.test(route.sample),
				),
		).map((route) => `${route.method} ${route.sample}`);
		const wronglyMocked = DAEMON_ROUTES.filter(
			(route) =>
				route.unmocked &&
				routes.some(
					(mock) =>
						mock.method === route.method && mock.pattern.test(route.sample),
				),
		).map((route) => `${route.method} ${route.sample}`);
		const extra = routes
			.filter(
				(mock) =>
					!DAEMON_ROUTES.some(
						(route) =>
							route.method === mock.method && mock.pattern.test(route.sample),
					),
			)
			.map((mock) => `${mock.method} ${mock.pattern}`);
		expect({ missing, wronglyMocked, extra }).toEqual({
			missing: [],
			wronglyMocked: [],
			extra: [],
		});
	});

	test("the mock's frame union names the same frame types as the daemon's ConsoleEvent", () => {
		const daemon = frameTypesIn(
			read("src/daemon/console-api.ts"),
			"ConsoleEvent",
		);
		const mock = frameTypesIn(
			read("website/src/mock/types.ts"),
			"ConsoleFrame",
		);
		expect(daemon.size).toBeGreaterThan(5);
		expect([...mock].sort()).toEqual([...daemon].sort());
	});

	test("the pattern reader sees both comparison and regex routes", () => {
		const found = routePatternsIn(
			'if (path === "/api/x" && m) {}\nconst r = /^\\/api\\/y\\/([^/]+)$/.exec(path);\nif (path.startsWith("/api/z")) {}',
		);
		expect([...found]).toEqual(['"/api/x"', String.raw`/^\/api\/y\/([^/]+)$/`]);
	});
});
