/**
 * Purpose: the package version, as one value every surface reads.
 *
 * Public API: `PACKAGE_VERSION`.
 *
 * Upstream deps: the package manifest itself.
 *
 * Downstream consumers: `../daemon/runtime` (reports it on `status`) and
 * `../extension/index` (compares it against the daemon's, so a session that
 * loads a newer plugin against a daemon left running from an older install
 * says so instead of behaving strangely).
 *
 * Failure modes: none at runtime — the import is resolved when the module
 * graph loads, and `package.json` ships in the published `files` list beside
 * `src`, so the relative path holds in a consumer install as well as here.
 */
import manifest from "../../package.json" with { type: "json" };

export const PACKAGE_VERSION: string = manifest.version;
