/**
 * Standalone repro: with a runtime `Bun.plugin` `onResolve` hook installed,
 * `import.meta.resolve` stops returning what the same call returns in a
 * process with no hook installed.
 *
 * Observation only. What this file produces is three pairs of counts, and the
 * counts are the whole claim. Every raw resolution is printed verbatim so the
 * strings are in the record rather than a summary of them. No mechanism is
 * asserted: "the handler is re-entered by the resolution it performs" is a
 * reading of upstream source, not something these counts measure, and it is
 * kept in the README's Context section instead of being claimed here. The two
 * hooked configurations end differently — the hand-written control throws,
 * upstream's handler returns a long `file:`-prefixed string — and this file
 * records both without explaining either.
 *
 * Sourced from upstream code, not measured here: an earlier cross-package
 * memoization theory is falsified by upstream's per-specifier cache key
 * (`@oh-my-pi/pi-coding-agent/src/extensibility/plugins/legacy-pi-compat.ts`,
 * `getResolvedSpecifier`, ~1127-1135) — that cache is keyed by the exact
 * specifier string, so it cannot carry one package's path into another's.
 * Nothing in this file measures that; it is read off the installed source.
 *
 * Correct/corrupted is decided by difference, not by any validity rule this
 * file invents. The parent process installs no hook, so its own resolution is
 * the baseline; each case prints its raw results and compares them to that
 * baseline string. Nothing here inspects the *shape* of a specifier.
 *
 * A `Bun.plugin` runtime hook is process-global and permanent — nothing
 * uninstalls it. So each case runs in its own child process:
 *
 *   installed  — upstream's shim, activated through its public export
 *   removed    — the same resolutions with no plugin at all (the control)
 *   bare       — a hand-written minimal onResolve hook, in a temp directory
 *                with its own trivial local package, no OMP package present
 *                and no OMP code loaded, `--no-install`, isolated HOME and
 *                BUN_INSTALL, no inherited BUN_* variables, and an audited
 *                ancestry
 *
 * The `bare` outcome selects the filing target. "It cannot borrow anything
 * from this directory" is checked rather than asserted: before the first
 * sandbox spawn the run walks from the sandbox to the filesystem root and
 * refuses the case if any ancestor carries a `bunfig.toml` variant or a
 * `node_modules` (see `auditAncestry`). A refused case is a control that did
 * not run, not a result.
 *
 * The verdict line is only a tracker recommendation when there is something to
 * recommend: it prints `file against: <target>` only when the failure
 * reproduced *and* the bare control was decisive, and otherwise prints an
 * explicit deferral naming why.
 *
 * Exit codes:
 *   0  reproduced, and the bare control decided a filing target
 *   1  ran cleanly, the reported failure did not appear
 *   2  could not run: wrong Bun, or the plugin-free baseline itself threw
 *   3  reproduced, but the bare control was not decisive — nothing to file
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REQUIRED_BUN = "1.3.14";
const N = 10;

/**
 * The specifier our own workaround avoids resolving, and the one the corrupted
 * resolution was observed on. It matches upstream's `@(scope)/pi-*` filter and
 * is resolvable under the package's exports map.
 *
 * Two different kinds of statement about it, kept apart on purpose:
 *
 *   recorded here  — with the shim installed this specifier resolves to a
 *                    4282-character `file:file:file:...` artifact instead of
 *                    the 134-character `file://` URL the same call returns
 *                    with no hook. That is measured output, printed verbatim.
 *   inferred       — that the artifact comes from an `onResolve` handler being
 *                    re-entered by its own `resolveSync` call is a reading of
 *                    upstream source (`legacy-pi-compat.ts:2867-2891`), not
 *                    something these counts establish.
 *
 * This file records one specifier and makes no claim about any other.
 */
const SPECIFIER = "@oh-my-pi/pi-coding-agent/package.json";

/** The `bare` sandbox resolves its own fixture package, never an OMP one. */
const BARE_SPECIFIER = "plainpkg/package.json";

type Case = "installed" | "removed" | "bare";
const CASES: Case[] = ["installed", "removed", "bare"];
/** The two cases that run as `--case` children of this file. */
const CHILD_CASES: Case[] = ["installed", "removed"];

type Counts = { differs: number; threw: number };
const VOID_COUNTS: Counts = { differs: -1, threw: -1 };

/**
 * What the `bare` control amounts to. `not-run` and `ambiguous` are kept
 * apart because they are different failures: the first has no counts to read,
 * the second has counts that do not decide. Only `decisive` names a tracker.
 */
type ControlVerdict =
	| { state: "decisive"; target: "oven-sh/bun" | "oh-my-pi" }
	| { state: "ambiguous" }
	| { state: "not-run" };

/**
 * Runtime gate. Runs before any hook is installed, in every process. Both
 * lines go to stderr: the version reading is the premise of the refusal
 * beneath it, and splitting them across streams separates a message from its
 * own reason.
 */
function requireExactBun(): void {
	console.error(`Bun.version: ${Bun.version}`);
	if (Bun.version !== REQUIRED_BUN) {
		console.error(
			`This repro is recorded against Bun ${REQUIRED_BUN} exactly; refusing to run on ${Bun.version}.`,
		);
		process.exit(2);
	}
}

/** One resolution. A throw is reported as such, never flattened into a string. */
function resolveOnce():
	| { ok: true; value: string }
	| { ok: false; message: string } {
	try {
		return { ok: true, value: import.meta.resolve(SPECIFIER) };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * N consecutive resolutions; every raw result printed. `differs` counts
 * results that are not byte-identical to the plugin-free baseline the parent
 * observed. `threw` is counted separately: a throw is not evidence that the
 * resolution returned a different string, so it must never be scored as a
 * byte difference.
 */
function record(label: Case, baseline: string): Counts {
	let differs = 0;
	let threw = 0;
	for (let i = 1; i <= N; i++) {
		const result = resolveOnce();
		if (!result.ok) {
			threw++;
			console.log(`[${label}] ${i}/${N} threw ${result.message}`);
			continue;
		}
		const same = result.value === baseline;
		if (!same) differs++;
		console.log(
			`[${label}] ${i}/${N} ${same ? "same-as-baseline" : "differs"} len=${result.value.length} ${result.value}`,
		);
	}
	console.log(`[${label}] RESULT differs=${differs}/${N} threw=${threw}/${N}`);
	return { differs, threw };
}

/** One child process per plugin configuration, because hooks cannot be removed. */
async function runChildCase(label: Case, baseline: string): Promise<void> {
	requireExactBun();
	console.log(`[${label}] specifier ${SPECIFIER}`);
	console.log(`[${label}] baseline len=${baseline.length} ${baseline}`);

	if (label === "installed") {
		// Dynamic import is required, not stylistic: a static import is hoisted
		// and would load this module — and with it the shim's install-time side
		// effects — in every case, including the `removed` control that must run
		// with no plugin in the process. The specifier is literal but the *point
		// at which it loads* is the variable under test.
		//
		// Shortest real activation path in the installed package: the shim's own
		// exported installer, reached through the published `./extensibility/*`
		// exports entry. Importing
		// `@oh-my-pi/pi-coding-agent/extensibility/plugins/loader` installs it as
		// a bare import side effect (loader.ts:21); this call is the explicit
		// form of the same thing.
		const { installLegacyPiSpecifierShim } = await import(
			"@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat"
		);
		installLegacyPiSpecifierShim();
	}

	record(label, baseline);
}

/**
 * The `bare` sandbox program, written into a temp directory at run time.
 *
 * It mirrors only the structural shape of upstream's hook — match a specifier,
 * resolve that same specifier from inside the handler, return the path — and
 * imports nothing. It is a separate file rather than a `--case` branch of this
 * one precisely so that it can run somewhere this directory's `node_modules`
 * is not reachable.
 */
function sandboxSource(): string {
	return `// Generated by repro.ts. Hand-written minimal Bun.plugin onResolve hook.
// Imports nothing: no OMP package is installed in this directory, and no OMP
// code is loaded into this process.
const REQUIRED_BUN = ${JSON.stringify(REQUIRED_BUN)};
const N = ${N};
const SPECIFIER = ${JSON.stringify(BARE_SPECIFIER)};
const FILTER = /^plainpkg(?:\\/.*)?$/;

console.error("[bare] Bun.version: " + Bun.version);
if (Bun.version !== REQUIRED_BUN) {
	console.error("[bare] requires Bun " + REQUIRED_BUN + "; got " + Bun.version);
	process.exit(2);
}

function resolveOnce() {
	try {
		return { ok: true, value: import.meta.resolve(SPECIFIER) };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

if (process.argv.includes("--emit-baseline")) {
	const first = resolveOnce();
	if (!first.ok) {
		console.error("BARE_BASELINE_THREW " + first.message);
		process.exit(2);
	}
	console.log("BARE_BASELINE " + first.value);
	process.exit(0);
}

const baselineFlag = process.argv.indexOf("--baseline");
const baseline = baselineFlag === -1 ? "" : process.argv[baselineFlag + 1];
if (!baseline) {
	console.error("[bare] missing --baseline");
	process.exit(2);
}
console.log("[bare] specifier " + SPECIFIER);
console.log("[bare] baseline len=" + baseline.length + " " + baseline);

Bun.plugin({
	name: "repro:bare-hook",
	setup(build) {
		build.onResolve({ filter: FILTER, namespace: "file" }, (args) => ({
			path: Bun.resolveSync(args.path, import.meta.dir),
		}));
	},
});

let differs = 0;
let threw = 0;
for (let i = 1; i <= N; i++) {
	const result = resolveOnce();
	if (!result.ok) {
		threw++;
		console.log("[bare] " + i + "/" + N + " threw " + result.message);
		continue;
	}
	const same = result.value === baseline;
	if (!same) differs++;
	console.log(
		"[bare] " + i + "/" + N + " " + (same ? "same-as-baseline" : "differs") +
			" len=" + result.value.length + " " + result.value,
	);
}
console.log("[bare] RESULT differs=" + differs + "/" + N + " threw=" + threw + "/" + N);
`;
}

function parseResult(label: Case, out: string): Counts | null {
	const match = out.match(
		new RegExp(`\\[${label}\\] RESULT differs=(\\d+)/${N} threw=(\\d+)/${N}`),
	);
	if (!match) return null;
	return { differs: Number(match[1]), threw: Number(match[2]) };
}

/** The file names Bun reads project configuration from, in directory order. */
const BUNFIG_NAMES = ["bunfig.toml", ".bunfig.toml"];

/**
 * Proves, rather than asserts, that the sandbox is alone.
 *
 * `cwd`, `--no-install` and an isolated HOME/BUN_INSTALL only control what the
 * sandbox process starts from; they say nothing about what sits *above* it.
 * Bun walks parent directories for both `bunfig.toml` and `node_modules`, so a
 * temp directory created underneath a checkout — or under a `TMPDIR` someone
 * pointed at one — would silently inherit configuration and packages while the
 * comment above it still claimed isolation.
 *
 * So the walk runs for real: from the sandbox's canonical parent to the
 * filesystem root, refusing on the first ancestor that carries a `bunfig.toml`
 * variant or a `node_modules`. The sandbox itself is excluded — it owns a
 * `node_modules` by design, that being the fixture under test.
 *
 * Returns the offending path, or `null` when the ancestry is clean.
 */
function auditAncestry(sandboxDir: string): string | null {
	let dir = dirname(realpathSync(sandboxDir));
	for (;;) {
		for (const name of [...BUNFIG_NAMES, "node_modules"]) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The `bare` case, in a temp directory it builds itself: a package fixture
 * with one trivial local package and nothing else, `--no-install` so Bun
 * cannot fetch anything, HOME/BUN_INSTALL pointed inside the sandbox so no
 * global cache or global install directory is consulted, every inherited
 * `BUN_*` variable explicitly unset, and an ancestry audited before the first
 * spawn.
 *
 * Two sandbox processes: one with no hook to establish that directory's own
 * plugin-free baseline, one with the hook installed. Returns `null` when the
 * control could not be established — a refused ancestry, a sandbox that could
 * not resolve its own fixture, a non-zero exit — which is a control that did
 * not run, not a result to read.
 */
function runBareCase(): Counts | null {
	const dir = mkdtempSync(join(tmpdir(), "bun-onresolve-bare-"));
	console.log(`[bare] sandbox ${dir}`);

	const contaminant = auditAncestry(dir);
	if (contaminant) {
		console.error(
			`[bare] control void: an ancestor of the sandbox holds ${contaminant}, which the sandbox would inherit, so it cannot be shown to resolve only its own fixture. The bare case did not run.`,
		);
		rmSync(dir, { recursive: true, force: true });
		return null;
	}
	console.log(
		`[bare] ancestry audited to the filesystem root: no bunfig.toml variant, no node_modules above the sandbox`,
	);

	try {
		mkdirSync(join(dir, "node_modules", "plainpkg"), { recursive: true });
		mkdirSync(join(dir, "home"), { recursive: true });
		mkdirSync(join(dir, "bun-install"), { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "bare-sandbox", private: true, type: "module" }, null, 2)}\n`,
		);
		writeFileSync(
			join(dir, "node_modules", "plainpkg", "package.json"),
			`${JSON.stringify({ name: "plainpkg", version: "1.0.0", main: "index.js" }, null, 2)}\n`,
		);
		writeFileSync(
			join(dir, "node_modules", "plainpkg", "index.js"),
			"export default 1;\n",
		);
		writeFileSync(join(dir, "sandbox.ts"), sandboxSource());

		// Isolation must not rest on Bun choosing replace-semantics over merge for
		// this object. Two layers, both unconditional:
		//
		//   1. every config variable that could reintroduce what the ancestry
		//      audit just ruled out is named and set to `undefined` whether or
		//      not this process carries it, so the removal is a property of this
		//      literal rather than of the parent environment at scan time,
		//   2. any other inherited `BUN_*` variable is swept the same way, so a
		//      knob added by a future Bun does not arrive silently.
		//
		// `NODE_OPTIONS` is included because it can preload code. Ours are
		// assigned last, so neither layer can take them with it.
		const swept = Object.fromEntries(
			Object.keys(process.env)
				.filter((key) => key.startsWith("BUN_"))
				.map((key) => [key, undefined]),
		);
		const env: Record<string, string | undefined> = {
			...swept,
			BUN_CONFIG: undefined,
			BUN_CONFIG_FILE: undefined,
			BUN_ENV: undefined,
			NODE_OPTIONS: undefined,
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: join(dir, "home"),
			BUN_INSTALL: join(dir, "bun-install"),
			TMPDIR: dir,
		};
		const sandbox = join(dir, "sandbox.ts");

		const first = Bun.spawnSync(
			[process.execPath, "--no-install", sandbox, "--emit-baseline"],
			{ cwd: dir, env, stdout: "pipe", stderr: "pipe" },
		);
		const firstOut = first.stdout.toString();
		process.stdout.write(firstOut);
		const firstErr = first.stderr.toString();
		if (firstErr) process.stderr.write(firstErr);
		const baselineMatch = firstOut.match(/^BARE_BASELINE (.+)$/m);
		if (first.exitCode !== 0 || !baselineMatch) {
			console.error(
				"[bare] control void: the sandbox could not resolve its own fixture with no hook installed",
			);
			return null;
		}
		const baseline = baselineMatch[1];

		const hooked = Bun.spawnSync(
			[process.execPath, "--no-install", sandbox, "--baseline", baseline],
			{ cwd: dir, env, stdout: "pipe", stderr: "pipe" },
		);
		const hookedOut = hooked.stdout.toString();
		process.stdout.write(hookedOut);
		const hookedErr = hooked.stderr.toString();
		if (hookedErr) process.stderr.write(hookedErr);
		if (hooked.exitCode !== 0) {
			console.error(`[bare] hooked sandbox exited ${hooked.exitCode}`);
			return null;
		}
		const counts = parseResult("bare", hookedOut);
		if (!counts) {
			console.error("[bare] hooked sandbox produced no RESULT line");
			return null;
		}
		return counts;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function runAll(): Promise<void> {
	requireExactBun();

	// This process installs no plugin, so its resolution is the baseline every
	// case is compared against. If the plugin-free resolution itself throws,
	// there is no baseline to compare anything to and the run is void.
	const baselineResult = resolveOnce();
	if (!baselineResult.ok) {
		console.error(
			`baseline resolution threw with no plugin installed: ${baselineResult.message}`,
		);
		console.error(
			"Without a plugin-free baseline there is nothing to compare against.",
		);
		process.exit(2);
	}
	const baseline = baselineResult.value;
	console.log(`specifier: ${SPECIFIER}`);
	console.log(
		`baseline (no plugin installed): len=${baseline.length} ${baseline}`,
	);

	const results: Record<Case, Counts> = {
		installed: VOID_COUNTS,
		removed: VOID_COUNTS,
		bare: VOID_COUNTS,
	};

	for (const label of CHILD_CASES) {
		console.log(`\n=== case: ${label} ===`);
		const child = Bun.spawnSync(
			[
				process.execPath,
				import.meta.path,
				"--case",
				label,
				"--baseline",
				baseline,
			],
			{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
		);
		const out = child.stdout.toString();
		process.stdout.write(out);
		const err = child.stderr.toString();
		if (err) process.stderr.write(err);
		if (child.exitCode !== 0) {
			console.error(`case ${label} exited ${child.exitCode}`);
			process.exit(child.exitCode ?? 1);
		}
		const counts = parseResult(label, out);
		if (!counts) {
			console.error(`case ${label} produced no RESULT line`);
			process.exit(1);
		}
		results[label] = counts;
	}

	console.log("\n=== case: bare ===");
	const bare = runBareCase();
	if (bare) results.bare = bare;

	// A throw is not evidence that a resolution returned a different string, so
	// any throw in the two cases that carry the claim voids it rather than
	// supporting it.
	const reproduced =
		results.installed.differs === N &&
		results.installed.threw === 0 &&
		results.removed.differs === 0 &&
		results.removed.threw === 0;

	// The bare case is OMP-free by construction, so it decides the tracker.
	// Either ending — every resolution throwing, or every resolution returning
	// a string that is not the baseline — is the hook changing what the same
	// call returns without it, with no OMP package on disk and no OMP code in
	// the process, so either routes to Bun. Only a clean N/N of one kind, or a
	// clean 0/0, decides anything.
	//
	// Two non-decisive endings exist and they are not the same thing, so they
	// are not collapsed: a control that could not run at all (refused ancestry,
	// a sandbox that could not resolve its own fixture, a non-zero exit) has no
	// counts to read, while a control that ran and returned a mixed count has
	// counts that simply do not decide. Both block filing; only the second is
	// evidence of anything.
	const control: ControlVerdict = !bare
		? { state: "not-run" }
		: bare.threw === N || (bare.threw === 0 && bare.differs === N)
			? { state: "decisive", target: "oven-sh/bun" }
			: bare.threw === 0 && bare.differs === 0
				? { state: "decisive", target: "oh-my-pi" }
				: { state: "ambiguous" };

	console.log("\n=== summary ===");
	console.log(`bun: ${Bun.version}`);
	console.log(`specifier: ${SPECIFIER}`);
	console.log(`bare specifier: ${BARE_SPECIFIER}`);
	console.log(`baseline: len=${baseline.length} ${baseline}`);
	for (const label of CASES) {
		const counts = results[label];
		console.log(
			counts === VOID_COUNTS
				? `${label}: void (no result recorded)`
				: `${label}: differs ${counts.differs}/${N} threw ${counts.threw}/${N}`,
		);
	}
	console.log(`reproduced: ${reproduced}`);
	console.log(
		`bare control: ${
			control.state === "decisive"
				? `decisive (${control.target})`
				: control.state === "ambiguous"
					? "ran, but its counts decide nothing"
					: "did not run"
		}`,
	);

	// A tracker recommendation is printed only when there is one to make. If
	// the failure did not reproduce, or the control did not decide, printing
	// `file against: <target>` would put a filing target in stdout for a run
	// that earned none — so the line explicitly defers instead, and names why.
	if (reproduced && control.state === "decisive") {
		console.log(`file against: ${control.target}`);
		process.exit(0);
	}
	console.log(
		`file against: deferred — ${
			!reproduced
				? "the reported failure did not reproduce in this run"
				: control.state === "ambiguous"
					? "the bare control ran but its counts decide no tracker"
					: "the bare control could not be established"
		}`,
	);

	// Non-zero when the recorded failure does not appear: there is then nothing
	// to file, and a green run would be misleading. A reproduction whose
	// control did not decide is also not filing-ready, and says so with its own
	// code rather than passing as if the target were known.
	if (!reproduced) process.exit(1);
	console.error(
		control.state === "ambiguous"
			? "reproduced, but the bare control returned a mixed count; read the raw [bare] lines before filing."
			: "reproduced, but the bare control could not run; there is no control result to read.",
	);
	process.exit(3);
}

const caseFlag = process.argv.indexOf("--case");
if (caseFlag !== -1) {
	const label = process.argv[caseFlag + 1] as Case;
	if (!CHILD_CASES.includes(label)) {
		console.error(`unknown case: ${label}`);
		process.exit(2);
	}
	const baselineFlag = process.argv.indexOf("--baseline");
	if (baselineFlag === -1 || !process.argv[baselineFlag + 1]) {
		console.error("missing --baseline");
		process.exit(2);
	}
	await runChildCase(label, process.argv[baselineFlag + 1]);
} else {
	await runAll();
}
