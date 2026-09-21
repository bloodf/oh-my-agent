import { expect, test } from "bun:test";
import { join } from "node:path";

interface PackageManifest {
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
}

/** The plugin may depend on blobatar and nothing else. */
const ALLOWED_DEPENDENCIES = new Set(["blobatar"]);

export function assertBuildHygiene(manifest: PackageManifest): void {
	const violations: string[] = [];
	if (manifest.scripts && "build" in manifest.scripts) {
		violations.push("scripts.build must be absent");
	}
	const extra = Object.keys(manifest.dependencies ?? {}).filter(
		(name) => !ALLOWED_DEPENDENCIES.has(name),
	);
	if (extra.length > 0) {
		violations.push(
			`dependencies may only include blobatar; found ${extra.join(", ")}`,
		);
	}
	if (violations.length > 0) {
		throw new Error(`Build hygiene violations: ${violations.join("; ")}`);
	}
}

test("package.json has no build script and only blobatar as a runtime dependency", async () => {
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
		error:
			"Build hygiene violations: dependencies may only include blobatar; found runtime-package",
	},
])("assertBuildHygiene rejects $label", ({ manifest, error }) => {
	expect(() => assertBuildHygiene(manifest)).toThrow(error);
});
