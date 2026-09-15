import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const siteRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(siteRoot, "..");

// The demo at /console mounts the real console from ../web/src. Everything
// resolves from website/node_modules so there is exactly one React instance.
const nextConfig: NextConfig = {
	distDir: process.env.NEXT_DIST_DIR || ".next",
	experimental: { externalDir: true },
	outputFileTracingRoot: repoRoot,
	images: { unoptimized: true },
	// Builds run on webpack (`--webpack`), which is where resolution is pinned.
	webpack: (config) => {
		config.resolve.modules = [join(siteRoot, "node_modules"), "node_modules"];
		config.resolve.alias = {
			...config.resolve.alias,
			"@": join(repoRoot, "web", "src"),
			"@site": join(siteRoot, "src"),
			// @designcodeio/threeui pins three@0.128 as "three128"; share the app's three.
			three128: join(siteRoot, "node_modules", "three"),
		};
		return config;
	},
};

export default nextConfig;
