/**
 * The console storybook must catalog every operator surface against the
 * production stylesheet. A workshop with missing pages is how "the UI is
 * ready" gets claimed without anyone seeing it.
 *
 * Status codes alone prove nothing about a React tree, so every catalogued
 * story is opened in a real headless Chrome and must render without a page
 * error or a console error.
 *
 * @Environment bun
 */

/** Browser globals used inside `page.evaluate` callbacks (no DOM lib here). */
declare const document: {
	querySelector(selector: string): { textContent: string | null } | null;
	getElementById(id: string): { childElementCount: number } | null;
};

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startStorybook } from "../storybook/console/serve";
import { STORIES } from "../storybook/console/stories.js";
import { resolveChrome } from "./fixtures/chrome";

let browser: Browser;

beforeAll(async () => {
	browser = await puppeteer.launch({
		executablePath: resolveChrome(),
		args: ["--no-sandbox"],
	});
}, 60_000);

afterAll(async () => {
	await browser?.close();
}, 30_000);

/** Open a page that records every page error and console error it raises. */
async function trackedPage(): Promise<{ page: Page; errors: string[] }> {
	const page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("requestfailed", (request) =>
		errors.push(`request failed: ${request.url()}`),
	);
	page.on("response", (response) => {
		if (response.status() >= 400)
			errors.push(`${response.status()} ${response.url()}`);
	});
	return { page, errors };
}

/** The story root has rendered something other than the unknown-story page. */
async function waitForStory(page: Page): Promise<string> {
	await page.waitForFunction(
		() => (document.getElementById("root")?.childElementCount ?? 0) > 0,
	);
	return page.evaluate(
		() => document.querySelector("#root")?.textContent ?? "",
	);
}

describe("console storybook server", () => {
	test("serves the workshop, production CSS, and a populated preview", async () => {
		const server = startStorybook(0);
		try {
			const origin = String(server.url).replace(/\/$/, "");
			const index = await fetch(`${origin}/catalog.html`);
			expect(index.status).toBe(200);
			expect(await index.text()).toContain("Console storybook");

			const css = await fetch(`${origin}/style.css`);
			expect(css.status).toBe(200);
			expect(await css.text()).toContain("--surface-0");

			const preview = await fetch(`${origin}/?story=page-populated`);
			expect(preview.status).toBe(200);
			expect(await preview.text()).toContain('data-storybook="true"');

			const missing = await fetch(`${origin}/nope`);
			expect(missing.status).toBe(404);
			const strayChunk = await fetch(`${origin}/chunk-../../package.json`);
			expect(strayChunk.status).toBe(404);
		} finally {
			await server.stop(true);
		}
	});

	test("every catalogued story renders in Chrome without errors", async () => {
		const server = startStorybook(0);
		const { page, errors } = await trackedPage();
		try {
			const origin = String(server.url).replace(/\/$/, "");
			await page.goto(`${origin}/catalog.html`, { waitUntil: "load" });
			const links = await page.$$eval("#nav a", (nodes) =>
				nodes.map((node) => node.getAttribute("href") ?? ""),
			);
			expect(links).toEqual(STORIES.map((story) => `#${story.id}`));

			for (const story of STORIES) {
				errors.length = 0;
				await page.goto(`${origin}/?story=${encodeURIComponent(story.id)}`, {
					waitUntil: "load",
				});
				const text = await waitForStory(page);
				expect({
					story: story.id,
					unknown: text.includes("Unknown story"),
				}).toEqual({
					story: story.id,
					unknown: false,
				});
				expect({ story: story.id, errors }).toEqual({
					story: story.id,
					errors: [],
				});
			}
		} finally {
			await page.close().catch(() => {});
			await server.stop(true);
		}
	}, 120_000);

	test("the changes story shows the truncated file list notice", async () => {
		const server = startStorybook(0);
		const { page, errors } = await trackedPage();
		try {
			const origin = String(server.url).replace(/\/$/, "");
			await page.goto(`${origin}/?story=page-changes`, { waitUntil: "load" });
			await page.waitForFunction(() =>
				(document.querySelector("#root")?.textContent ?? "").includes(
					"File list truncated",
				),
			);
			expect(errors).toEqual([]);
		} finally {
			await page.close().catch(() => {});
			await server.stop(true);
		}
	}, 60_000);

	test("a render error shows a recoverable message instead of a blank view", async () => {
		const server = startStorybook(0);
		const { page, errors } = await trackedPage();
		try {
			const origin = String(server.url).replace(/\/$/, "");
			await page.goto(`${origin}/?story=state-render-error`, {
				waitUntil: "load",
			});
			// The malformed timestamp is drawn as its own text, not thrown.
			await page.waitForFunction(() =>
				(document.querySelector("#artifacts")?.textContent ?? "").includes(
					"not-a-date",
				),
			);
			expect(errors).toEqual([]);

			await page.click("#story-break");
			await page.waitForSelector('[data-error-boundary="Artifacts"]');
			const fallback = await page.$eval(
				'[data-error-boundary="Artifacts"]',
				(node) => node.textContent ?? "",
			);
			expect(fallback).toContain("Artifacts could not be shown");
			expect(fallback).toContain("a malformed value reached this view");

			const tryAgain = await page.$$eval(
				'[data-error-boundary="Artifacts"] button',
				(nodes) => nodes.map((node) => node.textContent),
			);
			expect(tryAgain).toEqual(["Try again"]);
			await page.click('[data-error-boundary="Artifacts"] button');
			await page.waitForSelector("#artifacts");
			expect(await page.$('[data-error-boundary="Artifacts"]')).toBeNull();
		} finally {
			await page.close().catch(() => {});
			await server.stop(true);
		}
	}, 60_000);
});
