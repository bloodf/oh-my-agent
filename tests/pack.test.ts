import { expect, test } from "bun:test";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

async function packedPaths(): Promise<Set<string>> {
	const process = Bun.spawn(
		["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: PACKAGE_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);

	expect(exitCode, stderr).toBe(0);
	const [{ files }] = JSON.parse(stdout) as [{ files: { path: string }[] }];
	return new Set(files.map(({ path }) => path));
}

test("npm package contains runtime assets and excludes repository-only paths", async () => {
	const paths = await packedPaths();
	const skillManifests = await Array.fromAsync(
		new Bun.Glob("skills/*/SKILL.md").scan({ cwd: PACKAGE_ROOT }),
	);

	expect(skillManifests.length).toBeGreaterThan(0);
	for (const path of [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		"patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch",
		"src/daemon/main.ts",
		"src/console/index.html",
		"src/console/style.css",
		"src/console/app.js",
		...skillManifests,
	]) {
		expect(paths, `${path} missing from package`).toContain(path);
	}

	for (const prefix of ["tests/", "docs/", ".github/"]) {
		expect([...paths].filter((path) => path.startsWith(prefix))).toEqual([]);
	}
	expect(
		[...paths].filter((path) =>
			path.split("/").some((segment) => segment.startsWith(".")),
		),
	).toEqual([]);
});

test("prepack runs existing typecheck and test scripts", async () => {
	const { scripts } = (await Bun.file(
		resolve(PACKAGE_ROOT, "package.json"),
	).json()) as { scripts: Record<string, string> };

	expect(scripts.prepack).toBe("bun run typecheck && bun run test");
});
