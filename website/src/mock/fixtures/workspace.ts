/**
 * The machine the mocked daemon pretends to run on: a small directory tree
 * for the file picker, and two Git repositories with real-looking status and
 * unified diffs for the Changes view. Static, so it is never persisted.
 */
import type { RepoFixture } from "../types";

export const HOME = "/Users/you";
export const PROJECT = `${HOME}/code/quarry`;
export const UI_PROJECT = `${HOME}/code/quarry-web`;
export const UPLOAD_ROOT = "/private/var/folders/7k/oma-uploads";

/** Directory → entries. A name ending in "/" is a directory. */
const TREE: Record<string, string[]> = {
	"/": ["Users/", "private/", "tmp/"],
	"/Users": ["you/"],
	[HOME]: ["code/", "Desktop/", "Downloads/", "notes.md"],
	[`${HOME}/code`]: ["quarry/", "quarry-web/", "infra/"],
	[PROJECT]: [".github/", "benches/", "docs/", "src/", "tests/", ".gitignore", "README.md", "bun.lock", "package.json", "tsconfig.json"],
	[`${PROJECT}/.github`]: ["workflows/"],
	[`${PROJECT}/.github/workflows`]: ["ci.yml", "release.yml"],
	[`${PROJECT}/benches`]: ["tokenizer.bench.ts", "corpus-10k.jsonl"],
	[`${PROJECT}/docs`]: ["architecture.md", "query-language.md", "release-notes/"],
	[`${PROJECT}/docs/release-notes`]: ["v0.8.md", "v0.9.md"],
	[`${PROJECT}/src`]: ["api/", "indexer/", "query/", "server.ts"],
	[`${PROJECT}/src/api`]: ["search.ts", "health.ts", "rate-limit.ts"],
	[`${PROJECT}/src/indexer`]: ["tokenizer.ts", "segment-writer.ts", "merge-policy.ts"],
	[`${PROJECT}/src/query`]: ["parse.ts", "plan.ts", "score.ts"],
	[`${PROJECT}/tests`]: ["tokenizer.test.ts", "segment-writer.test.ts", "search.e2e.test.ts"],
	[UI_PROJECT]: ["public/", "src/", "package.json", "vite.config.ts"],
	[`${UI_PROJECT}/public`]: ["favicon.svg"],
	[`${UI_PROJECT}/src`]: ["App.tsx", "SearchBox.tsx", "ResultList.tsx", "main.tsx"],
	[`${HOME}/code/infra`]: ["terraform/", "README.md"],
	[`${HOME}/code/infra/terraform`]: ["main.tf", "variables.tf"],
	[`${HOME}/Desktop`]: ["latency-p99.png", "quarry-roadmap.pdf"],
	[`${HOME}/Downloads`]: ["crash-report-2291.txt", "customer-queries.csv"],
	"/private": ["var/"],
	"/private/var": ["folders/"],
	"/private/var/folders": [],
	"/tmp": ["quarry-bench.log"],
};

export type FileEntry = { name: string; path: string; directory: boolean };

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

export function normalizePath(path: string): string {
	const trimmed = path.trim().replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

export function isDirectory(path: string): boolean {
	return normalizePath(path) in TREE;
}

export function listDirectory(path: string): { path: string; parent: string; entries: FileEntry[] } | null {
	const dir = normalizePath(path);
	const names = TREE[dir];
	if (!names) return null;
	const entries = names
		.map((name) => ({ name: name.replace(/\/$/, ""), path: join(dir, name.replace(/\/$/, "")), directory: name.endsWith("/") }))
		.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
	const parent = dir === "/" ? "/" : dir.slice(0, dir.lastIndexOf("/")) || "/";
	return { path: dir, parent, entries };
}

export function isFile(path: string): boolean {
	const dir = normalizePath(path);
	const cut = dir.lastIndexOf("/");
	const parent = cut <= 0 ? "/" : dir.slice(0, cut);
	return (TREE[parent] ?? []).includes(dir.slice(cut + 1));
}

const TOKENIZER_WORKING = [
	"diff --git a/src/indexer/tokenizer.ts b/src/indexer/tokenizer.ts",
	"index 4f1c2a9..b83e0d1 100644",
	"--- a/src/indexer/tokenizer.ts",
	"+++ b/src/indexer/tokenizer.ts",
	"@@ -12,18 +12,27 @@ export interface Token {",
	" const WORD = /[\\p{L}\\p{N}_]+/gu;",
	"+const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;",
	" ",
	"-export function tokenize(text: string): Token[] {",
	"+export function tokenize(text: string, options: TokenizeOptions = {}): Token[] {",
	"   const tokens: Token[] = [];",
	"   for (const match of text.matchAll(WORD)) {",
	"-    tokens.push({ term: match[0].toLowerCase(), offset: match.index ?? 0 });",
	"+    const offset = match.index ?? 0;",
	"+    tokens.push({ term: match[0].toLowerCase(), offset });",
	"+    if (!options.splitIdentifiers) continue;",
	"+    // getUserById → get, user, by, id: indexed at their own offsets so",
	"+    // phrase queries still line up with the source text.",
	"+    let cursor = offset;",
	"+    for (const part of match[0].split(CAMEL_BOUNDARY)) {",
	"+      if (part.length > 1 && part !== match[0]) {",
	"+        tokens.push({ term: part.toLowerCase(), offset: cursor });",
	"+      }",
	"+      cursor += part.length;",
	"+    }",
	"   }",
	"   return tokens;",
	" }",
].join("\n");

const SEGMENT_STAGED = [
	"diff --git a/src/indexer/segment-writer.ts b/src/indexer/segment-writer.ts",
	"index 91aa0c3..2c7d5e8 100644",
	"--- a/src/indexer/segment-writer.ts",
	"+++ b/src/indexer/segment-writer.ts",
	"@@ -41,9 +41,12 @@ export class SegmentWriter {",
	"   async flush(): Promise<SegmentMeta> {",
	"-    const bytes = encodePostings(this.postings);",
	"-    await writeFile(this.path, bytes);",
	"+    const bytes = encodePostings(this.postings);",
	"+    // Write beside the target and rename: a crash mid-flush used to leave",
	"+    // a truncated segment that the merge policy then refused to open.",
	"+    const tmp = `${this.path}.${process.pid}.tmp`;",
	"+    await writeFile(tmp, bytes);",
	"+    await rename(tmp, this.path);",
	"     return { path: this.path, docs: this.docCount, bytes: bytes.byteLength };",
	"   }",
].join("\n");

const SEGMENT_WORKING = [
	"diff --git a/src/indexer/segment-writer.ts b/src/indexer/segment-writer.ts",
	"index 2c7d5e8..6f0b1a4 100644",
	"--- a/src/indexer/segment-writer.ts",
	"+++ b/src/indexer/segment-writer.ts",
	"@@ -1,4 +1,4 @@",
	"-import { writeFile } from \"node:fs/promises\";",
	"+import { rename, writeFile } from \"node:fs/promises\";",
	" import { encodePostings } from \"./postings\";",
	" import type { SegmentMeta } from \"./types\";",
].join("\n");

const SEARCH_WORKING = [
	"diff --git a/src/api/search.ts b/src/api/search.ts",
	"index 0d2e7b1..a51c9f3 100644",
	"--- a/src/api/search.ts",
	"+++ b/src/api/search.ts",
	"@@ -27,7 +27,11 @@ export async function search(request: Request): Promise<Response> {",
	"   const query = parse(params.get(\"q\") ?? \"\");",
	"-  const limit = Number(params.get(\"limit\") ?? 20);",
	"+  const requested = Number(params.get(\"limit\") ?? 20);",
	"+  if (!Number.isInteger(requested) || requested < 1) {",
	"+    return Response.json({ error: { message: \"limit must be a positive integer\" } }, { status: 400 });",
	"+  }",
	"+  const limit = Math.min(requested, MAX_LIMIT);",
	"   const hits = await index.search(query, { limit });",
	"   return Response.json({ hits, took: performance.now() - started });",
].join("\n");

const PARSE_RENAME = [
	"diff --git a/src/query/parser.ts b/src/query/parse.ts",
	"similarity index 94%",
	"rename from src/query/parser.ts",
	"rename to src/query/parse.ts",
	"index 7a1b0e2..c4d9f81 100644",
	"--- a/src/query/parser.ts",
	"+++ b/src/query/parse.ts",
	"@@ -3,6 +3,6 @@ import type { QueryNode } from \"./plan\";",
	"-export function parseQuery(input: string): QueryNode {",
	"+export function parse(input: string): QueryNode {",
	"   const trimmed = input.trim();",
	"   if (trimmed === \"\") return { kind: \"match_all\" };",
].join("\n");

const TOKENIZER_TEST = [
	"diff --git a/tests/tokenizer.test.ts b/tests/tokenizer.test.ts",
	"index 3e8f6d0..91c0b27 100644",
	"--- a/tests/tokenizer.test.ts",
	"+++ b/tests/tokenizer.test.ts",
	"@@ -22,3 +22,14 @@ test(\"keeps offsets for unicode words\", () => {",
	"   expect(tokenize(\"naïve café\").map((t) => t.offset)).toEqual([0, 6]);",
	" });",
	"+",
	"+test(\"splits identifiers when asked\", () => {",
	"+  const terms = tokenize(\"getUserById\", { splitIdentifiers: true }).map((t) => t.term);",
	"+  expect(terms).toEqual([\"getuserbyid\", \"get\", \"user\", \"by\", \"id\"]);",
	"+});",
	"+",
	"+test(\"does not split acronyms into letters\", () => {",
	"+  const terms = tokenize(\"parseHTTPRequest\", { splitIdentifiers: true }).map((t) => t.term);",
	"+  expect(terms).toContain(\"http\");",
	"+});",
].join("\n");

const RELEASE_NOTES = [
	"diff --git a/docs/release-notes/v0.9.md b/docs/release-notes/v0.9.md",
	"new file mode 100644",
	"index 0000000..e1f2a3b",
	"--- /dev/null",
	"+++ b/docs/release-notes/v0.9.md",
	"@@ -0,0 +1,12 @@",
	"+# Quarry 0.9",
	"+",
	"+## Search",
	"+- Identifier-aware tokenization: `getUserById` matches `user by id`.",
	"+- `limit` is validated and capped at 200.",
	"+",
	"+## Indexing",
	"+- Segment flushes are atomic; a crash can no longer leave a truncated segment.",
	"+",
	"+## Upgrade notes",
	"+- `parseQuery` is now `parse`. The old name is removed.",
	"+- Re-index once to pick up identifier splitting.",
].join("\n");

const CI_WORKING = [
	"diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
	"index 5b0d1e4..8a3c2f7 100644",
	"--- a/.github/workflows/ci.yml",
	"+++ b/.github/workflows/ci.yml",
	"@@ -18,6 +18,8 @@ jobs:",
	"       - uses: oven-sh/setup-bun@v2",
	"       - run: bun install --frozen-lockfile",
	"       - run: bun test",
	"+      - run: bun run bench -- --corpus benches/corpus-10k.jsonl --budget-ms 850",
	"+        name: Tokenizer throughput budget",
].join("\n");

const QUARRY: RepoFixture = {
	root: PROJECT,
	branch: "feat/identifier-tokens",
	files: [
		{ path: ".github/workflows/ci.yml", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
		{ path: "benches/corpus-10k.jsonl", indexStatus: "A", worktreeStatus: " ", staged: true, unstaged: false, untracked: false },
		{ path: "docs/release-notes/v0.9.md", indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: false, untracked: true },
		{ path: "src/api/search.ts", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
		{ path: "src/indexer/segment-writer.ts", indexStatus: "M", worktreeStatus: "M", staged: true, unstaged: true, untracked: false },
		{ path: "src/indexer/tokenizer.ts", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
		{ path: "src/query/parse.ts", originalPath: "src/query/parser.ts", indexStatus: "R", worktreeStatus: " ", staged: true, unstaged: false, untracked: false },
		{ path: "tests/tokenizer.test.ts", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
	],
	diffs: {
		"working:.github/workflows/ci.yml": CI_WORKING,
		"working:docs/release-notes/v0.9.md": RELEASE_NOTES,
		"working:src/api/search.ts": SEARCH_WORKING,
		"staged:src/indexer/segment-writer.ts": SEGMENT_STAGED,
		"working:src/indexer/segment-writer.ts": SEGMENT_WORKING,
		"working:src/indexer/tokenizer.ts": TOKENIZER_WORKING,
		"staged:src/query/parse.ts": PARSE_RENAME,
		"working:tests/tokenizer.test.ts": TOKENIZER_TEST,
	},
};

const QUARRY_WEB: RepoFixture = {
	root: UI_PROJECT,
	branch: "main",
	files: [
		{ path: "src/ResultList.tsx", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
		{ path: "public/favicon.svg", indexStatus: "M", worktreeStatus: " ", staged: true, unstaged: false, untracked: false },
	],
	diffs: {
		"working:src/ResultList.tsx": [
			"diff --git a/src/ResultList.tsx b/src/ResultList.tsx",
			"index 1c2d3e4..5f6a7b8 100644",
			"--- a/src/ResultList.tsx",
			"+++ b/src/ResultList.tsx",
			"@@ -14,7 +14,9 @@ export function ResultList({ hits }: { hits: Hit[] }) {",
			"   return (",
			"-    <ul>",
			"+    <ul aria-live=\"polite\" aria-busy={loading}>",
			"       {hits.map((hit) => (",
			"-        <li key={hit.id}>{hit.path}</li>",
			"+        <li key={hit.id}>",
			"+          <ResultRow hit={hit} />",
			"+        </li>",
			"       ))}",
		].join("\n"),
	},
};

const REPOS = [QUARRY, QUARRY_WEB];

export function repoFor(cwd: string): RepoFixture | undefined {
	const path = normalizePath(cwd);
	return REPOS.find((repo) => path === repo.root || path.startsWith(`${repo.root}/`));
}

/** `diff` for binary fixtures is unused; the corpus is reported as binary. */
export const BINARY_PATHS = new Set(["benches/corpus-10k.jsonl"]);
