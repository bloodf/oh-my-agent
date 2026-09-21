// @ts-nocheck
/**
 * Capture docs/assets/console.png and collaboration.png from the storybook
 * after `bun run console:build`. Copies the same files to website/public/home/.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { startStorybook } from "../storybook/console/serve";
import { resolveChrome } from "../tests/fixtures/chrome";

const ROOT = join(import.meta.dir, "..");
const SHOTS = [
	{ story: "page-populated", file: "console.png" },
	{ story: "page-thread", file: "collaboration.png" },
] as const;

const server = startStorybook(0);
const browser = await puppeteer.launch({
	executablePath: resolveChrome(),
	args: ["--no-sandbox", "--hide-scrollbars"],
});
try {
	await mkdir(join(ROOT, "docs", "assets"), { recursive: true });
	await mkdir(join(ROOT, "website", "public", "home"), { recursive: true });
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
	for (const shot of SHOTS) {
		const url = new URL("/", server.url);
		url.searchParams.set("story", shot.story);
		await page.goto(url.href, { waitUntil: "networkidle0" });
		const dest = join(ROOT, "docs", "assets", shot.file);
		await page.screenshot({ path: dest, type: "png" });
		await copyFile(dest, join(ROOT, "website", "public", "home", shot.file));
		process.stdout.write(`${shot.file}\n`);
	}
} finally {
	await browser.close();
	server.stop();
}
