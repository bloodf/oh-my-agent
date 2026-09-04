import { expect, test } from "bun:test";

import {
	bumpManifest,
	bumpManifestText,
	cutUnreleased,
	draftFromCommits,
	extractNotes,
	mergeDraftIntoUnreleased,
	parseChangelog,
	unreleasedBody,
} from "../scripts/cut-changelog";

const SAMPLE = `# Changelog

Preamble.

## [Unreleased]

### Changed

- Docs overhaul.

## [1.0.1] - 2026-09-04

### Fixed

- Example agents.
`;

test("parseChangelog splits Unreleased from releases", () => {
	const parsed = parseChangelog(SAMPLE);
	expect(unreleasedBody(parsed.unreleased)).toContain("Docs overhaul");
	expect(parsed.releases).toContain("## [1.0.1]");
});

test("cutUnreleased moves Unreleased under a dated version", () => {
	const next = cutUnreleased(SAMPLE, "1.0.2", "2026-09-05");
	expect(next).toContain("## [Unreleased]\n\n## [1.0.2] - 2026-09-05");
	expect(next).toContain("- Docs overhaul.");
	expect(next.indexOf("## [1.0.2]")).toBeLessThan(next.indexOf("## [1.0.1]"));
});

test("cutUnreleased rejects an empty Unreleased", () => {
	const empty = SAMPLE.replace("### Changed\n\n- Docs overhaul.\n\n", "");
	expect(() => cutUnreleased(empty, "1.0.2", "2026-09-05")).toThrow(
		/Unreleased is empty/,
	);
});

test("cutUnreleased rejects a duplicate version", () => {
	expect(() => cutUnreleased(SAMPLE, "1.0.1", "2026-09-05")).toThrow(
		/already has/,
	);
});

test("draftFromCommits groups conventional subjects and skips chore/ci", () => {
	const draft = draftFromCommits([
		"feat: add schedule pause",
		"fix: bound budget bump (T-1618)",
		"docs: rewrite README",
		"chore: bump lockfile",
		"ci: widen timeout",
	]);
	expect(draft).toContain("### Added");
	expect(draft).toContain("- Add schedule pause");
	expect(draft).toContain("### Fixed");
	expect(draft).toContain("- Bound budget bump");
	expect(draft).toContain("### Changed");
	expect(draft).toContain("- Rewrite README");
	expect(draft).not.toContain("lockfile");
	expect(draft).not.toContain("timeout");
});

test("draftFromCommits fails when nothing is draftable", () => {
	expect(() => draftFromCommits(["chore: noise", "ci: noise"])).toThrow(
		/no draftable commits/,
	);
});

test("mergeDraftIntoUnreleased fills an empty Unreleased only", () => {
	const empty = SAMPLE.replace("### Changed\n\n- Docs overhaul.\n\n", "");
	const merged = mergeDraftIntoUnreleased(empty, "### Added\n\n- Pause.\n");
	expect(merged).toContain("### Added");
	expect(merged).toContain("- Pause.");
	expect(() => mergeDraftIntoUnreleased(SAMPLE, "### Added\n\n- x\n")).toThrow(
		/already has entries/,
	);
});

test("extractNotes returns one version section", () => {
	const notes = extractNotes(SAMPLE, "1.0.1");
	expect(notes).toContain("## [1.0.1] - 2026-09-04");
	expect(notes).toContain("- Example agents.");
	expect(notes).not.toContain("Unreleased");
	expect(notes).not.toContain("Docs overhaul");
});

test("bumpManifest and bumpManifestText update root and omp.version", () => {
	const bumped = bumpManifest(
		{ version: "1.0.1", omp: { name: "oh-my-agent", version: "1.0.1" } },
		"1.0.2",
	);
	expect(bumped.version).toBe("1.0.2");
	expect(bumped.omp?.version).toBe("1.0.2");
	expect(bumped.omp?.name).toBe("oh-my-agent");

	const text = `{
	"name": "@bloodf/oh-my-agent",
	"version": "1.0.1",
	"omp": {
		"name": "oh-my-agent",
		"version": "1.0.1"
	}
}
`;
	expect(bumpManifestText(text, "1.0.2")).toContain('"version": "1.0.2"');
	expect(bumpManifestText(text, "1.0.2").split("1.0.2").length - 1).toBe(2);
});

test("cutUnreleased fails closed: revert the empty-Unreleased throw and this test fails", () => {
	const empty = `# Changelog\n\n## [Unreleased]\n\n## [1.0.1] - 2026-09-04\n`;
	expect(() => cutUnreleased(empty, "1.0.2", "2026-09-05")).toThrow(
		/Unreleased is empty/,
	);
});
