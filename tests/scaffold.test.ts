import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

describe("oh-my-agent scaffold", () => {
	const ROOT = import.meta.dir;

	test("package.json has type module", async () => {
		const pkg = await import(`${ROOT}/../package.json`);
		expect(pkg.type).toBe("module");
	});

	test("package.json omp.extensions points to src/extension/index.ts", async () => {
		const pkg = await import(`${ROOT}/../package.json`);
		const ext = pkg.omp.extensions;
		expect(ext).toBeArray();
		expect(ext).toContain("src/extension/index.ts");
	});

	test("dynamic import of extension exposes default function", async () => {
		const mod = await import(`${ROOT}/../src/extension/index.ts`);
		expect(typeof mod.default).toBe("function");
	});

	test("extension load registers commands and events but performs no runtime actions", async () => {
		const mod = await import(`${ROOT}/../src/extension/index.ts`);
		const calls: string[] = [];

		const probe = {
			registerTool: () => {
				calls.push("registerTool");
			},
			registerCommand: () => {
				calls.push("registerCommand");
			},
			on: () => {
				calls.push("on");
			},
			sendMessage: () => {
				calls.push("sendMessage");
			},
			sendUserMessage: () => {
				calls.push("sendUserMessage");
			},
			appendEntry: () => {
				calls.push("appendEntry");
			},
		};

		mod.default(probe as unknown as ExtensionAPI);
		// Registration is the load-time activity: the operator commands and the
		// widget events must be registered here.
		expect(calls.filter((c) => c === "registerCommand")).toHaveLength(7);
		expect(calls.filter((c) => c === "on").length).toBeGreaterThanOrEqual(1);
		// Runtime actions during load throw ExtensionRuntimeNotInitializedError
		// in a real session; the factory must not attempt any.
		expect(calls).not.toContain("sendMessage");
		expect(calls).not.toContain("sendUserMessage");
		expect(calls).not.toContain("appendEntry");
		expect(calls).not.toContain("registerTool");
	});
});
