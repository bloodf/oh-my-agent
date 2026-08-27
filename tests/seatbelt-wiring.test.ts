/**
 * §7 seatbelt wiring: the compiled profile must describe the worker's *real*
 * materialized layout, not fixture paths.
 *
 * `tests/sandbox.test.ts` already covers the compiler in isolation. What it
 * cannot show is that the paths and ports baked into a profile are the ones a
 * worker actually uses — a policy that guards the wrong directory or the wrong
 * loopback port is worse than none, because it looks enforced.
 *
 * These tests materialize a worker, gate it, and assert the resulting profile
 * against that layout's own values.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { materializeWorker } from "../src/daemon/materializer";
import type { WorkerLayout } from "../src/daemon/materializer";
import { parsePeerDefinition } from "../src/shared/agent-definition";
import type { PeerDefinition } from "../src/shared/agent-definition";
import { resolveSandboxLaunch } from "../src/worker/launch-gate";

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function peer(frontmatter: Record<string, unknown> = {}): PeerDefinition {
	const yaml = Object.entries({
		name: "reviewer",
		description: "Reviews PRs.",
		model: "anthropic/claude-sonnet-4-5",
		spawns: ["scout"],
		sandbox: true,
		...frontmatter,
	})
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return parsePeerDefinition("/agents/reviewer.md", `---\n${yaml}\n---\nYou are the reviewer.`);
}

/** Materialize a worker against a gateway on `port`. */
async function materialized(
	port: number,
	overrides: Record<string, unknown> = {},
): Promise<{ cwd: string; layout: WorkerLayout; parsedPeer: PeerDefinition }> {
	const base = await mkdtemp(join(tmpdir(), "oh-my-agent-sb-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));

	const parsedPeer = peer(overrides);
	const layout = await materializeWorker({
		rootDir: join(base, "worker"),
		parsedPeer,
		discoveredAgentNames: [],
		inferenceGateway: { url: `http://127.0.0.1:${port}`, token: "tok" },
		sourceSpawnAgents: {
			scout: `---\nname: scout\ndescription: Reads code.\n---\nYou are a scout.`,
		},
	});

	return { cwd: base, layout, parsedPeer };
}

/** Gate a materialized worker on Darwin with stubbed probes. */
async function profileFor(port: number, overrides: Record<string, unknown> = {}) {
	const { cwd, layout, parsedPeer } = await materialized(port, overrides);
	const extraRoots =
		typeof parsedPeer.sandbox === "object" && Array.isArray(parsedPeer.sandbox.extraRoots)
			? parsedPeer.sandbox.extraRoots
			: [];

	const launch = await resolveSandboxLaunch({
		policy: {
			workspace: cwd,
			workerHome: layout.home,
			runtimePaths: ["/usr/bin", "/bin"],
			inferenceGateway: layout.inferenceGateway,
			loopbackPorts: [layout.inferenceGateway.port],
			extraRoots,
		},
		command: ["bun", "/path/to/cli.js"],
		platform: "darwin",
		which: async () => "/usr/bin/sandbox-exec",
		probeBridge: async () => true,
	});

	return { profile: launch.args[1] as string, cwd, layout, launch };
}

// ── Profile reflects the materialized layout ─────────────────────────────────

describe("seatbelt profile matches the materialized worker", () => {
	test("writes are scoped to the real synthetic home, not a fixture path", async () => {
		const { profile, layout } = await profileFor(18801);

		expect(profile).toContain(`(allow file-write* (subpath "${layout.home}"))`);
		// The agent dir lives under that home, so the worker can write its own
		// session files.
		expect(layout.agentDir.startsWith(layout.home)).toBe(true);
	});

	test("writes are scoped to the real project workspace", async () => {
		const { profile, cwd } = await profileFor(18802);

		expect(profile).toContain(`(allow file-write* (subpath "${cwd}"))`);
	});

	test("the allowed loopback port is the materialized gateway port", async () => {
		const { profile, layout } = await profileFor(18803);

		expect(layout.inferenceGateway.port).toBe(18803);
		expect(profile).toContain(`(allow network-outbound (remote ip "127.0.0.1:18803"))`);
	});

	test("a different gateway port produces a different profile", async () => {
		const first = await profileFor(18804);
		const second = await profileFor(18805);

		expect(first.profile).not.toBe(second.profile);
		expect(first.profile).toContain("127.0.0.1:18804");
		expect(second.profile).not.toContain("127.0.0.1:18804");
	});

	test("network is denied by default", async () => {
		const { profile } = await profileFor(18806);

		expect(profile).toContain("(deny network*)");
	});

	test("a peer's extraRoots are readable but not writable", async () => {
		const { profile } = await profileFor(18807, {
			sandbox: { enabled: true, extraRoots: ["/opt/shared-lib"] },
		});

		expect(profile).toContain(`(allow file-read* (subpath "/opt/shared-lib"))`);
		expect(profile).not.toContain(`(allow file-write* (subpath "/opt/shared-lib"))`);
	});

	test("the profile grants no write access outside workspace and home", async () => {
		const { profile, cwd, layout } = await profileFor(18808);

		const writes = [...profile.matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)].map(
			(match) => match[1],
		);
		expect(writes.sort()).toEqual([cwd, layout.home].sort());
	});

	test("the gated argv ends with the real command payload", async () => {
		const { launch } = await profileFor(18809);

		expect(launch.command).toBe("sandbox-exec");
		expect(launch.args.slice(-2)).toEqual(["bun", "/path/to/cli.js"]);
	});
});

// ── Materialization boundary rejects unroutable gateways ─────────────────────

/** The spawn sources every fixture peer needs. */
const SPAWN_SOURCES = {
	scout: `---\nname: scout\ndescription: Reads code.\n---\nYou are a scout.`,
};

describe("gateway endpoint validation", () => {
	test("a gateway URL without an explicit port is rejected", async () => {
		const base = await mkdtemp(join(tmpdir(), "oh-my-agent-sb-"));
		cleanups.push(() => rm(base, { recursive: true, force: true }));

		// An implicit port would resolve to 0 and fail policy compilation later,
		// so materialization refuses it up front.
		await expect(
			materializeWorker({
				rootDir: join(base, "worker"),
				parsedPeer: peer(),
				discoveredAgentNames: [],
				inferenceGateway: { url: "http://127.0.0.1", token: "tok" },
				sourceSpawnAgents: SPAWN_SOURCES,
			}),
		).rejects.toThrow(/explicit port/);
	});

	test("a non-loopback gateway is rejected before anything is written", async () => {
		const base = await mkdtemp(join(tmpdir(), "oh-my-agent-sb-"));
		cleanups.push(() => rm(base, { recursive: true, force: true }));

		// The Darwin compiler hard-codes 127.0.0.1, so a non-loopback gateway
		// would compile a profile the worker never dials.
		await expect(
			materializeWorker({
				rootDir: join(base, "worker"),
				parsedPeer: peer(),
				discoveredAgentNames: [],
				inferenceGateway: { url: "http://10.0.0.5:9999", token: "tok" },
				sourceSpawnAgents: SPAWN_SOURCES,
			}),
		).rejects.toThrow(/loopback/);

		expect(await Bun.file(join(base, "worker", "home", ".omp", "agent", "models.yml")).exists()).toBe(
			false,
		);
	});
});
