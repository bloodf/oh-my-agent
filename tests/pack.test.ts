import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

function extractNpmPackMetadata(stdout: string): { filename: string } {
	// npm pack --json output can be preceded by prepack lifecycle logs
	// (typecheck/test output), so scan backward from the end for the
	// final valid JSON value that carries pack metadata.
	for (let i = stdout.length - 1; i >= 0; i--) {
		const ch = stdout[i];
		if (ch !== "[" && ch !== "{") continue;
		try {
			const parsed = JSON.parse(stdout.slice(i));
			const entry = Array.isArray(parsed) ? parsed[0] : parsed;
			if (entry && typeof entry.filename === "string") return entry;
		} catch {
			// not a valid JSON start here; keep scanning backward
		}
	}
	throw new Error(`npm pack JSON not found in stdout:\n${stdout}`);
}

async function packedPaths(): Promise<Set<string>> {
	let packDir: string | undefined;
	let tarball: string;
	const suppliedTarball = process.env.OMA_PACKED_TARBALL;
	try {
		if (suppliedTarball) {
			tarball = resolve(suppliedTarball);
		} else {
			packDir = await mkdtemp(join(tmpdir(), "oma-pack-test-"));
			const pack = Bun.spawn(
				["npm", "pack", "--json", "--silent", "--pack-destination", packDir],
				{
					cwd: PACKAGE_ROOT,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: process.env.HOME ?? tmpdir(),
						NO_COLOR: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				pack.exited,
				new Response(pack.stdout).text(),
				new Response(pack.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			const { filename } = extractNpmPackMetadata(stdout);
			tarball = join(packDir, filename);
		}

		expect(existsSync(tarball), `${tarball} missing`).toBe(true);
		const archive = Bun.spawn(["tar", "-tzf", tarball], {
			cwd: PACKAGE_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			archive.exited,
			new Response(archive.stdout).text(),
			new Response(archive.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		return new Set(
			stdout
				.split("\n")
				.filter(Boolean)
				.map((path) => path.replace(/^package\//, "")),
		);
	} finally {
		if (packDir) await rm(packDir, { recursive: true, force: true });
	}
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
}, 180_000);

test("prepack runs typecheck and fast suites", async () => {
	const { scripts } = (await Bun.file(
		resolve(PACKAGE_ROOT, "package.json"),
	).json()) as { scripts: Record<string, string> };

	expect(scripts.prepack).toBe("bun run typecheck && bun run test:fast");
});
