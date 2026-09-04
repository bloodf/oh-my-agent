import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

export function extractNpmPackMetadata(stdout: string): { filename: string } {
	// npm has emitted both array and package-keyed object payloads across
	// supported versions. Lifecycle scripts can write before either payload,
	// so scan backward for the final valid JSON value carrying pack metadata.
	for (let i = stdout.length - 1; i >= 0; i--) {
		const ch = stdout[i];
		if (ch !== "[" && ch !== "{") continue;
		try {
			const parsed: unknown = JSON.parse(stdout.slice(i));
			const entries = Array.isArray(parsed)
				? parsed
				: parsed &&
						typeof parsed === "object" &&
						"filename" in parsed &&
						typeof parsed.filename === "string"
					? [parsed]
					: parsed && typeof parsed === "object"
						? Object.values(parsed)
						: [];
			for (const entry of entries) {
				if (
					entry &&
					typeof entry === "object" &&
					"filename" in entry &&
					typeof entry.filename === "string"
				) {
					return { filename: entry.filename };
				}
			}
		} catch {
			// This is not a valid JSON start, so keep scanning backward.
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

test("extractNpmPackMetadata supports npm pack JSON output shapes", () => {
	expect(extractNpmPackMetadata('[{"filename":"x.tgz"}]')).toEqual({
		filename: "x.tgz",
	});
	expect(
		extractNpmPackMetadata('{"@bloodf/oh-my-agent":{"filename":"x.tgz"}}'),
	).toEqual({ filename: "x.tgz" });
	expect(
		extractNpmPackMetadata('prepack: bun test\n{"filename":"x.tgz"}'),
	).toEqual({
		filename: "x.tgz",
	});
	expect(() => extractNpmPackMetadata("no pack metadata")).toThrow(
		"npm pack JSON not found in stdout:\nno pack metadata",
	);
});

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

	// npm 12 strips the file named by patchedDependencies from packed tarballs,
	// so this patch cannot ship through npm. ADR-013 established it could never
	// affect consumers anyway: Bun honors patchedDependencies only from the
	// consumer's root manifest, and a tarball cannot alter a resolved peer dependency.
	expect([...paths].filter((path) => path.startsWith("patches/"))).toEqual([]);
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
