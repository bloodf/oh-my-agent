#!/usr/bin/env bun
/**
 * Calls every mocked console route once, outside the browser, and reports
 * any that throw or answer 5xx. Run from website/: `bun scripts/mock-smoke.mjs`.
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

/** [method, path, body?, expected status?] — one call per route, in dependency order. */
const CALLS = [
	["GET", "/api/capabilities"],
	["GET", "/api/models"],
	["GET", "/api/presets"],
	["POST", "/api/session"],
	["POST", "/api/ws-ticket"],
	["GET", "/api/channels"],
	["POST", "/api/channels", { id: "#smoke", workspace: PROJECT }, 201],
	["PATCH", `/api/channels/${q("#smoke")}`, { workspace: null }],
	["GET", `/api/channels/${q("#quarry-core")}/messages?limit=500`],
	["POST", `/api/channels/${q("#quarry-core")}/messages`, { body: "smoke @atlas", author: "@you", parentId: null }, 201],
	["POST", "/api/messages/1/reactions/toggle", { emoji: "✅" }],
	["GET", `/api/channels/${q("#release")}/plans`],
	["POST", `/api/channels/${q("#release")}/plans`, { title: "Smoke", body: "- [ ] check" }, 201],
	["PATCH", `/api/channels/${q("#release")}/plans/plan-quarry-09`, { status: "completed", expectedRevision: 4 }],
	["PATCH", `/api/channels/${q("#release")}/plans/plan-quarry-09`, { status: "active", expectedRevision: 4 }, 409],
	["GET", "/api/agents"],
	["POST", "/api/agents", { name: "smoke-bot", description: "Smoke", body: "Say hi.", spawns: "*", rooms: ["#smoke"], wake: { rooms: true, mention: false }, schedules: [{ cron: "0 9 * * 1-5", prompt: "Hi" }] }, 201],
	["GET", `/api/agents/smoke-bot/definition`],
	["PATCH", `/api/agents/smoke-bot`, { description: "Smoke, edited" }],
	["POST", `/api/agents/smoke-bot/start`, {}],
	["POST", `/api/agents/smoke-bot/rooms`, { room: "#release" }],
	["DELETE", `/api/agents/smoke-bot/rooms/${q("#release")}`],
	["POST", `/api/agents/smoke-bot/inject`, { message: "focus" }],
	["GET", `/api/agents/smoke-bot/logs?lines=20`],
	["POST", `/api/agents/atlas/kill`, { keepChildren: true }],
	["POST", "/api/accounts/anthropic/bump", { budgetUsd: 60 }],
	["GET", "/api/schedules"],
	["PATCH", `/api/schedules/${q("ledger-bot:schedule:1")}`, { enabled: true }],
	["GET", "/api/artifacts"],
	["POST", "/api/artifacts", { file: `${PROJECT}/docs/review/release-0.9-dashboard.html` }],
	["GET", "/api/profile"],
	["PUT", "/api/profile", { operator: { displayName: "Smoke", avatar: "🧪" }, agents: { atlas: { displayName: "" } } }],
	["GET", `/api/workspace/files?path=${q(PROJECT)}`],
	["GET", `/api/workspace/changes?cwd=${q(PROJECT)}`],
	["GET", `/api/workspace/diff?cwd=${q(PROJECT)}&path=${q("src/indexer/tokenizer.ts")}&staged=false`],
	["GET", "/api/attachments"],
	["POST", "/api/attachments", undefined, 201, { "x-attachment-name": "notes.txt", "content-type": "text/plain" }],
	["GET", "/api/chats"],
	["POST", "/api/chats", { cwd: PROJECT, title: "Smoke chat" }, 201],
	["GET", "/api/chats/chat-7f3a/state"],
	["GET", "/api/chats/chat-7f3a/messages"],
	["GET", "/api/chats/chat-7f3a/models"],
	["POST", "/api/chats/chat-7f3a/model", { provider: "openai", modelId: "gpt-5.6" }],
	["POST", "/api/chats/chat-7f3a/prompt", { message: "go", paths: [`${PROJECT}/README.md`] }, 202],
	["POST", "/api/chats/chat-7f3a/abort", {}],
	["GET", "/api/definitely-not-a-route"],
];

const failures = [];
const covered = new Set();
let uploadId;
for (const [method, path, body, expected, extraHeaders] of CALLS) {
	const url = new URL(path, "http://localhost");
	const match = ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
	if (match) covered.add(`${match.method} ${match.pattern}`);
	try {
		const result = await handleApi({ method, url, headers: { ...TOKEN, ...extraHeaders }, body });
		if (path === "/api/attachments" && method === "POST") uploadId = result.body.id;
		const ok = expected ? result.status === expected : result.status >= 200 && result.status < 300;
		console.log(`${ok ? "ok  " : "FAIL"} ${result.status} ${method} ${path}`);
		if (!ok) failures.push(`${method} ${path} → ${result.status} ${JSON.stringify(result.body)}`);
	} catch (error) {
		failures.push(`${method} ${path} threw ${error?.stack ?? error}`);
		console.log(`THROW ${method} ${path}`);
	}
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

const uncovered = ROUTES.filter((r) => !covered.has(`${r.method} ${r.pattern}`)).map((r) => `${r.method} ${r.pattern}`);
cancelActivity();
console.log(`\n${covered.size}/${ROUTES.length} mocked routes called; frames: ${[...new Set(frames)].join(", ")}`);
if (uncovered.length) console.log(`not called: ${uncovered.join("; ")}`);
if (failures.length) {
	console.log(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("no throws, no unexpected statuses");
process.exit(0);
