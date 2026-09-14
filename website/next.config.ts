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
	turbopack: {
		root: repoRoot,
		resolveAlias: {
			"@": join(repoRoot, "web", "src"),
			"@site": join(siteRoot, "src"),
		},
	},
	webpack: (config) => {
		config.resolve.modules = [join(siteRoot, "node_modules"), "node_modules"];
		config.resolve.alias = {
			...config.resolve.alias,
			"@": join(repoRoot, "web", "src"),
			"@site": join(siteRoot, "src"),
		};
		return config;
	},
};

export default nextConfig;
