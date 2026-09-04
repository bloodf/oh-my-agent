/**
 * Purpose: Keep-a-Changelog helpers for the manual release ritual.
 *   Cut Unreleased into a dated version, draft Unreleased from commit
 *   subjects, extract GitHub Release notes, bump package.json + omp.version.
 *
 * Public API: parseChangelog, cutUnreleased, draftFromCommits, extractNotes,
 *   bumpManifest, main.
 *
 * Failure modes: empty Unreleased on cut; version already present; missing
 *   Unreleased heading; version not found on notes extract.
 */
const UNRELEASED = "## [Unreleased]";

export interface Changelog {
	preamble: string;
	unreleased: string;
	releases: string;
}

export function parseChangelog(text: string): Changelog {
	const start = text.indexOf(UNRELEASED);
	if (start < 0) {
		throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
	}
	const afterHeading = start + UNRELEASED.length;
	const next = text.slice(afterHeading).search(/^## \[/m);
	const unreleasedEnd = next < 0 ? text.length : afterHeading + next;
	return {
		preamble: text.slice(0, start),
		unreleased: text.slice(afterHeading, unreleasedEnd).replace(/^\n+/, ""),
		releases: next < 0 ? "" : text.slice(unreleasedEnd),
	};
}

export function unreleasedBody(unreleased: string): string {
	return unreleased.trim();
}

export function cutUnreleased(
	text: string,
	version: string,
	date: string,
): string {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(
			`version must be semver X.Y.Z, got ${JSON.stringify(version)}`,
		);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
	}
	const parsed = parseChangelog(text);
	const body = unreleasedBody(parsed.unreleased);
	if (!body) {
		throw new Error("Unreleased is empty; fill it or draft from commits first");
	}
	const heading = `## [${version}]`;
	if (parsed.releases.includes(heading)) {
		throw new Error(`CHANGELOG.md already has ${heading}`);
	}
	return `${parsed.preamble}${UNRELEASED}\n\n${heading} - ${date}\n\n${body}\n\n${parsed.releases}`;
}

const SECTION_FOR_PREFIX: Array<[RegExp, string]> = [
	[/^feat(\(.+\))?:/i, "Added"],
	[/^fix(\(.+\))?:/i, "Fixed"],
	[/^security(\(.+\))?:/i, "Security"],
	[/^docs(\(.+\))?:/i, "Changed"],
	[/^perf(\(.+\))?:/i, "Changed"],
	[/^refactor(\(.+\))?:/i, "Changed"],
	[/^revert(\(.+\))?:/i, "Fixed"],
];

function stripPrefix(subject: string): string {
	return subject.replace(
		/^(feat|fix|docs|perf|refactor|revert|security|chore|ci|test|style|build)(\(.+\))?:\s*/i,
		"",
	);
}

export function draftFromCommits(subjects: readonly string[]): string {
	const buckets = new Map<string, string[]>();
	for (const raw of subjects) {
		const subject = raw.trim();
		if (!subject) continue;
		if (/^chore(\(.+\))?:/i.test(subject)) continue;
		if (/^ci(\(.+\))?:/i.test(subject)) continue;
		if (/^test(\(.+\))?:/i.test(subject)) continue;
		if (/^style(\(.+\))?:/i.test(subject)) continue;
		if (/^build(\(.+\))?:/i.test(subject)) continue;
		if (/^release(\(.+\))?:/i.test(subject)) continue;
		let section = "Changed";
		for (const [re, name] of SECTION_FOR_PREFIX) {
			if (re.test(subject)) {
				section = name;
				break;
			}
		}
		const line = stripPrefix(subject).replace(/\s+\(T-\d+\)$/, "");
		if (!line) continue;
		const list = buckets.get(section) ?? [];
		list.push(`- ${line.charAt(0).toUpperCase()}${line.slice(1)}`);
		buckets.set(section, list);
	}
	const order = ["Added", "Changed", "Fixed", "Security"];
	const parts: string[] = [];
	for (const name of order) {
		const items = buckets.get(name);
		if (!items || items.length === 0) continue;
		parts.push(`### ${name}\n\n${items.join("\n")}`);
	}
	if (parts.length === 0) {
		throw new Error(
			"no draftable commits (feat/fix/docs/perf/refactor/security)",
		);
	}
	return `${parts.join("\n\n")}\n`;
}

export function mergeDraftIntoUnreleased(text: string, draft: string): string {
	const parsed = parseChangelog(text);
	const existing = unreleasedBody(parsed.unreleased);
	if (existing) {
		throw new Error("Unreleased already has entries; not overwriting");
	}
	return `${parsed.preamble}${UNRELEASED}\n\n${draft.trimEnd()}\n\n${parsed.releases}`;
}

export function extractNotes(text: string, version: string): string {
	const heading = `## [${version}]`;
	const start = text.indexOf(heading);
	if (start < 0) {
		throw new Error(`CHANGELOG.md has no ${heading} heading`);
	}
	const after = text.slice(start);
	const next = after.slice(heading.length).search(/^## \[/m);
	const section = (
		next < 0 ? after : after.slice(0, heading.length + next)
	).trim();
	return `${section}\n`;
}

export interface PackageManifest {
	version: string;
	omp?: { version?: string; [key: string]: unknown };
	[key: string]: unknown;
}

export function bumpManifest(
	manifest: PackageManifest,
	version: string,
): PackageManifest {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(
			`version must be semver X.Y.Z, got ${JSON.stringify(version)}`,
		);
	}
	const omp = manifest.omp ? { ...manifest.omp, version } : { version };
	return { ...manifest, version, omp };
}

/** Patch the first two `"version"` keys (root, then omp.version) without reordering. */
export function bumpManifestText(text: string, version: string): string {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(
			`version must be semver X.Y.Z, got ${JSON.stringify(version)}`,
		);
	}
	let seen = 0;
	const next = text.replace(/"version": "[^"]+"/g, (match) => {
		seen += 1;
		if (seen <= 2) return `"version": "${version}"`;
		return match;
	});
	if (seen < 2) {
		throw new Error("package.json must contain root version and omp.version");
	}
	return next;
}

export const DEGRADED_PID_FOOTER = `
## Known limitation

npm consumers receive an unpatched \`@oh-my-pi/pi-coding-agent\` peer (ADR-013). \`RpcClient.pid\` is absent, so worker supervision cannot rely on the OMP patch. \`bun install\` from a checkout applies the repo patch; npm consumers do not.
`.trim();

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[]): Promise<string> {
	const [cmd, ...rest] = argv;
	const args = new Map<string, string>();
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (
			token?.startsWith("--") &&
			rest[i + 1] &&
			!rest[i + 1].startsWith("--")
		) {
			args.set(token.slice(2), rest[i + 1]);
			i += 1;
		}
	}
	if (cmd === "cut") {
		const version = args.get("version");
		const date = args.get("date");
		if (!version || !date) {
			throw new Error("cut requires --version X.Y.Z --date YYYY-MM-DD");
		}
		const text = await Bun.file("CHANGELOG.md").text();
		return cutUnreleased(text, version, date);
	}
	if (cmd === "notes") {
		const version = args.get("version");
		if (!version) throw new Error("notes requires --version X.Y.Z");
		const text = await Bun.file("CHANGELOG.md").text();
		return `${extractNotes(text, version)}\n${DEGRADED_PID_FOOTER}\n`;
	}
	if (cmd === "draft-commits") {
		const raw = await readStdin();
		const subjects = raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		return draftFromCommits(subjects);
	}
	if (cmd === "merge-draft") {
		const text = await Bun.file("CHANGELOG.md").text();
		const draft = await readStdin();
		return mergeDraftIntoUnreleased(text, draft);
	}
	if (cmd === "bump-manifest") {
		const version = args.get("version");
		if (!version) throw new Error("bump-manifest requires --version X.Y.Z");
		const text = await Bun.file("package.json").text();
		return bumpManifestText(text, version);
	}
	throw new Error(
		"usage: cut-changelog.ts cut|notes|draft-commits|merge-draft|bump-manifest",
	);
}

if (import.meta.main) {
	try {
		const out = await main(Bun.argv.slice(2));
		process.stdout.write(out);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	}
}
