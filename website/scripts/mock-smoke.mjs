/**
 * Calls every mocked console route once, outside the browser, and fails on a
 * throw, an unexpected status, a body without the fields the console reads, a
 * call no mock route serves, or a frame set that differs from the daemon's.
 * Run from website/: `bun scripts/mock-smoke.mjs`.
 */
const memory = new Map();
globalThis.localStorage = {
	getItem: (key) => memory.get(key) ?? null,
	setItem: (key, value) => memory.set(key, String(value)),
	removeItem: (key) => memory.delete(key),
	key: (index) => [...memory.keys()][index] ?? null,
	get length() {
		return memory.size;
	},
	clear: () => memory.clear(),
};

const { handleApi, ROUTES } = await import("../src/mock/router.ts");
const { subscribe } = await import("../src/mock/bus.ts");
const { cancelActivity } = await import("../src/mock/activity.ts");

const frames = [];
subscribe((frame) => frames.push(frame.type));

const TOKEN = { "x-operator-token": "demo" };
const q = encodeURIComponent;
const PROJECT = "/Users/you/code/quarry";

const isList = (key) => (body) => Array.isArray(body?.[key]);
const hasError = (code) => (body) => body?.error?.code === code && typeof body.error.message === "string";
/** The two newest #quarry-core ids, read by the `limit=2` call for the `before` call after it. */
let newest = [];
const AVATAR = `data:image/png;base64,${Buffer.from("smoke-png-bytes!").toString("base64")}`;

/**
 * [method, path, body?, expected status?, extra headers?, body check?] — one
 * call per route, in dependency order, plus the refusals the daemon answers.
 */
const CALLS = [
	["GET", "/api/capabilities", undefined, 200, undefined, (b) => typeof b.fullControl === "boolean"],
	["GET", "/api/models"],
	["GET", "/api/presets", undefined, 200, undefined, isList("presets")],
	["POST", "/api/session", undefined, 200, undefined, (b) => typeof b.ticket === "string"],
	["POST", "/api/ws-ticket", undefined, 200, undefined, (b) => typeof b.ticket === "string"],
	["GET", "/api/channels", undefined, 200, undefined, isList("channels")],
	["POST", "/api/channels", { id: "#smoke", workspace: PROJECT }, 201, undefined, (b) => b.channel?.id === "#smoke" && b.channel.workspace === PROJECT],
	["PATCH", `/api/channels/${q("#smoke")}`, { workspace: null }, 200, undefined, (b) => b.channel?.id === "#smoke" && !("workspace" in b.channel)],
	["GET", `/api/channels/${q("#quarry-core")}/messages?limit=500`, undefined, 200, undefined, isList("messages")],
	["POST", `/api/channels/${q("#quarry-core")}/messages`, { body: "smoke @atlas", author: "@you", parentId: null }, 201, undefined, (b) => b.message?.author === "@you"],
	// Without a cursor the newest N come back, oldest first; `before` pages further back.
	["GET", `/api/channels/${q("#quarry-core")}/messages?limit=2`, undefined, 200, undefined, (b) => {
		newest = b.messages.map((m) => m.id);
		return b.messages.length === 2 && b.messages[1].body === "smoke @atlas" && b.messages[0].id < b.messages[1].id;
	}],
	[
		"GET",
		() => `/api/channels/${q("#quarry-core")}/messages?limit=1&before=${newest[1]}`,
		undefined,
		200,
		undefined,
		(b) => b.messages.length === 1 && b.messages[0].id === newest[0],
	],
	[
		"GET",
		() => `/api/channels/${q("#quarry-core")}/messages?afterId=${newest[0]}&limit=5`,
		undefined,
		200,
		undefined,
		(b) => b.messages.length === 1 && b.messages[0].id === newest[1],
	],
	["POST", "/api/messages/1/reactions/toggle", { emoji: "✅" }, 200, undefined, (b) => typeof b.reacted === "boolean"],
	["GET", `/api/channels/${q("#release")}/plans`, undefined, 200, undefined, isList("plans")],
	["POST", `/api/channels/${q("#release")}/plans`, { title: "Smoke", body: "" }, 201, undefined, (b) => b.plan?.revision === 1 && b.plan.body === ""],
	["POST", `/api/channels/${q("#release")}/plans`, { title: "   ", body: "x" }, 400, undefined, hasError("INVALID_PLAN")],
	["GET", `/api/channels/${q("#nowhere")}/plans`, undefined, 400, undefined, hasError("ROOM_NOT_FOUND")],
	["PATCH", `/api/channels/${q("#release")}/plans/plan-quarry-09`, { status: "completed", expectedRevision: 4 }, 200, undefined, (b) => b.plan?.revision === 5],
	["PATCH", `/api/channels/${q("#release")}/plans/plan-quarry-09`, { status: "active", expectedRevision: 4 }, 409, undefined, hasError("PLAN_REVISION_CONFLICT")],
	["PATCH", `/api/channels/${q("#release")}/plans/missing`, { status: "active", expectedRevision: 1 }, 400, undefined, hasError("PLAN_NOT_FOUND")],
	["GET", "/api/agents", undefined, 200, undefined, isList("agents")],
	["POST", "/api/agents", { name: "smoke-bot", description: "Smoke", body: "Say hi.", spawns: "*", rooms: ["#smoke"], wake: { rooms: true, mention: false }, schedules: [{ cron: "0 9 * * 1-5", prompt: "Hi" }] }, 201],
	// A definition that never started is unknown to the daemon's operations.
	["GET", `/api/agents/smoke-bot/logs`, undefined, 404, undefined, hasError("not_found")],
	["GET", `/api/agents/smoke-bot/definition`, undefined, 200, undefined, (b) => b.definition?.name === "smoke-bot"],
	["PATCH", `/api/agents/smoke-bot`, { description: "Smoke, edited" }, 200, undefined, (b) => typeof b.rebuildRequired === "boolean"],
	["POST", `/api/agents/smoke-bot/start`, {}, 200, undefined, (b) => b.agent?.state === "running"],
	["POST", `/api/agents/smoke-bot/rooms`, { room: "#release" }, 200, undefined, isList("rooms")],
	["DELETE", `/api/agents/smoke-bot/rooms/${q("#release")}`, undefined, 200, undefined, isList("rooms")],
	["POST", `/api/agents/smoke-bot/inject`, { message: "focus" }, 200, undefined, (b) => b.queued === false],
	["GET", `/api/agents/smoke-bot/logs?lines=20`, undefined, 200, undefined, isList("lines")],
	["POST", `/api/agents/atlas/kill`, { keepChildren: true }, 200, undefined, (b) => b.state === "stopped" && b.keptChildren === true && b.cascaded === false],
	["POST", `/api/agents/atlas/inject`, { message: "wake up" }, 400, undefined, hasError("invalid_request")],
	["GET", "/api/schedules", undefined, 200, undefined, isList("schedules")],
	["PATCH", `/api/schedules/${q("ledger-bot:schedule:1")}`, { enabled: true }, 200, undefined, (b) => b.schedule?.enabled === true],
	["GET", "/api/artifacts", undefined, 200, undefined, isList("artifacts")],
	["POST", "/api/artifacts", { file: `${PROJECT}/docs/review/release-0.9-dashboard.html` }, 200, undefined, (b) => typeof b.artifact?.url === "string"],
	["GET", "/api/profile", undefined, 200, undefined, (b) => typeof b.profile?.operator === "object"],
	["PUT", "/api/profile", { operator: { displayName: "Smoke", avatar: "🧪" }, agents: { atlas: { displayName: "", avatar: AVATAR } } }, 200, undefined, (b) => b.profile?.agents?.atlas?.avatar === AVATAR],
	["PUT", "/api/profile", { operator: { avatar: "data:image/svg+xml;base64,PHN2Zz4=" } }, 400, undefined, hasError("invalid_request")],
	["GET", `/api/workspace/files?path=${q(PROJECT)}`],
	["GET", `/api/workspace/changes?cwd=${q(PROJECT)}`, undefined, 200, undefined, isList("files")],
	["GET", `/api/workspace/diff?cwd=${q(PROJECT)}&path=${q("src/indexer/tokenizer.ts")}&staged=false`, undefined, 200, undefined, (b) => typeof b.diff === "string"],
	["GET", "/api/attachments", undefined, 200, undefined, isList("attachments")],
	["POST", "/api/attachments", undefined, 201, { "x-attachment-name": "notes.txt", "content-type": "text/plain" }, (b) => typeof b.id === "string"],
	["GET", "/api/chats", undefined, 200, undefined, isList("chats")],
	["POST", "/api/chats", { cwd: PROJECT, title: "Smoke chat" }, 201, undefined, (b) => typeof b.chat?.id === "string"],
	["GET", "/api/chats/chat-7f3a/state", undefined, 200, undefined, (b) => typeof b.state?.streaming === "boolean"],
	["GET", "/api/chats/chat-7f3a/messages", undefined, 200, undefined, isList("messages")],
	["GET", "/api/chats/chat-7f3a/models", undefined, 200, undefined, isList("models")],
	["POST", "/api/chats/chat-7f3a/model", { provider: "openai", modelId: "gpt-5.6" }],
	["POST", "/api/chats/chat-7f3a/prompt", { message: "go", paths: [`${PROJECT}/README.md`] }, 202],
	["POST", "/api/chats/chat-7f3a/abort", {}, 200, undefined, (b) => b.aborted === true],
];

/** Refusals that must not match any mocked route: the daemon's 404 envelope. */
const UNSERVED = [["GET", "/api/definitely-not-a-route"], ["POST", "/api/accounts/anthropic/bump"]];

/** Every frame `ConsoleEvent` in src/daemon/console-api.ts defines, minus `budget`, which only quota changes the demo does not simulate emit. */
const EXPECTED_FRAMES = ["agent", "channel", "chat", "definition", "membership", "message", "plan", "profile", "reaction", "schedule"];

const failures = [];
const covered = new Set();
let uploadId;
for (const [method, pathOrThunk, body, expected, extraHeaders, check] of CALLS) {
	const path = typeof pathOrThunk === "function" ? pathOrThunk() : pathOrThunk;
	const url = new URL(path, "http://localhost");
	const match = ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
	if (match) covered.add(`${match.method} ${match.pattern}`);
	else failures.push(`${method} ${path} matches no mocked route`);
	try {
		const result = await handleApi({ method, url, headers: { ...TOKEN, ...extraHeaders }, body });
		if (path === "/api/attachments" && method === "POST") uploadId = result.body.id;
		const statusOk = expected ? result.status === expected : result.status >= 200 && result.status < 300;
		const shapeOk = !check || check(result.body ?? {});
		const ok = statusOk && shapeOk;
		console.log(`${ok ? "ok  " : "FAIL"} ${result.status} ${method} ${path}`);
		if (!ok) failures.push(`${method} ${path} → ${result.status}${shapeOk ? "" : " (body shape)"} ${JSON.stringify(result.body)}`);
	} catch (error) {
		failures.push(`${method} ${path} threw ${error?.stack ?? error}`);
		console.log(`THROW ${method} ${path}`);
	}
}

for (const [method, path] of UNSERVED) {
	const url = new URL(path, "http://localhost");
	if (ROUTES.some((r) => r.method === method && r.pattern.test(url.pathname))) failures.push(`${method} ${path} should not be mocked`);
	const result = await handleApi({ method, url, headers: TOKEN, body: {} });
	const ok = result.status === 404 && hasError("not_found")(result.body);
	console.log(`${ok ? "ok  " : "FAIL"} ${result.status} ${method} ${path}`);
	if (!ok) failures.push(`${method} ${path} → ${result.status} ${JSON.stringify(result.body)}, expected 404 not_found`);
}

// Routes that need an id minted above.
for (const [method, path] of [
	["DELETE", `/api/attachments/${uploadId}`],
	["DELETE", "/api/chats/chat-2c91"],
]) {
	const url = new URL(path, "http://localhost");
	const match = ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
	if (match) covered.add(`${match.method} ${match.pattern}`);
	const result = await handleApi({ method, url, headers: TOKEN, body: undefined });
	const ok = result.status < 300;
	console.log(`${ok ? "ok  " : "FAIL"} ${result.status} ${method} ${path}`);
	if (!ok) failures.push(`${method} ${path} → ${result.status}`);
}

const refused = await handleApi({ method: "GET", url: new URL("http://localhost/api/channels"), headers: {}, body: undefined });
if (refused.status !== 401 || refused.body.error.message !== "Operator token refused") failures.push("missing token was not refused with 401");

// Frames publish synchronously with each write; simulated follow-up turns are dropped.
const seen = new Set(frames);
cancelActivity();
const uncovered = ROUTES.filter((r) => !covered.has(`${r.method} ${r.pattern}`)).map((r) => `${r.method} ${r.pattern}`);
console.log(`\n${covered.size}/${ROUTES.length} mocked routes called; frames: ${[...seen].sort().join(", ")}`);
if (uncovered.length) failures.push(`routes never called: ${uncovered.join("; ")}`);
const frameDiff = [...EXPECTED_FRAMES.filter((t) => !seen.has(t)).map((t) => `missing ${t}`), ...[...seen].filter((t) => !EXPECTED_FRAMES.includes(t)).map((t) => `unexpected ${t}`)];
if (frameDiff.length) failures.push(`frame types differ: ${frameDiff.join(", ")}`);
if (failures.length) {
	console.log(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("no throws, no unexpected statuses or shapes, every route called, frame set matches");
process.exit(0);
