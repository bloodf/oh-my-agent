import { expect, test } from "bun:test";
import { join } from "node:path";

interface PackageManifest {
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
}

export function assertBuildHygiene(manifest: PackageManifest): void {
	const violations: string[] = [];
	if (manifest.scripts && "build" in manifest.scripts) {
		violations.push("scripts.build must be absent");
	}
	if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
		violations.push("dependencies must be absent or empty");
	}
	if (violations.length > 0) {
		throw new Error(`Build hygiene violations: ${violations.join("; ")}`);
	}
}

test("package.json has no build script or runtime dependencies", async () => {
	const manifest = (await Bun.file(
		join(import.meta.dir, "..", "package.json"),
	).json()) as PackageManifest;

	expect(() => assertBuildHygiene(manifest)).not.toThrow();
});

test.each([
	{
		label: "build scripts",
		manifest: { scripts: { build: "bun build src/index.ts" } },
		error: "Build hygiene violations: scripts.build must be absent",
	},
	{
		label: "runtime dependencies",
		manifest: { dependencies: { "runtime-package": "1.0.0" } },
		error: "Build hygiene violations: dependencies must be absent or empty",
	},
])("assertBuildHygiene rejects $label", ({ manifest, error }) => {
	expect(() => assertBuildHygiene(manifest)).toThrow(error);
});
