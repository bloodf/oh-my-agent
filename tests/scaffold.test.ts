import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";

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

  test("extension invoked with registration-probe causes zero registration calls", async () => {
    const mod = await import(`${ROOT}/../src/extension/index.ts`);
    const calls: string[] = [];

    const probe = {
      registerTool: () => { calls.push("registerTool"); },
      registerCommand: () => { calls.push("registerCommand"); },
      on: () => { calls.push("on"); },
      sendMessage: () => { calls.push("sendMessage"); },
      sendUserMessage: () => { calls.push("sendUserMessage"); },
      appendEntry: () => { calls.push("appendEntry"); },
    };

    mod.default(probe as unknown as ExtensionAPI);
    expect(calls).toHaveLength(0);
  });
});
