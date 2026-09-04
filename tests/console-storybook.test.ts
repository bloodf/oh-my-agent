/**
 * The console storybook must catalog every operator surface against the
 * production stylesheet. A workshop with missing pages is how "the UI is
 * ready" gets claimed without anyone seeing it.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { startStorybook } from "../storybook/console/serve";

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
		} finally {
			await server.stop(true);
		}
	});
});
