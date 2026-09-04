/**
 * The console storybook must catalog every operator surface against the
 * production stylesheet. A workshop with missing pages is how "the UI is
 * ready" gets claimed without anyone seeing it.
 *
 * @Environment bun
 */
import { describe, expect, test } from "bun:test";
import { startStorybook } from "../storybook/console/serve";
import { STORIES } from "../storybook/console/stories.js";

const REQUIRED_IDS = [
	"page-populated",
	"page-empty",
	"page-offline",
	"page-load-failure",
	"page-auth",
	"page-auth-refused",
	"comp-channels",
	"comp-messages",
	"comp-composer",
	"comp-thread",
	"comp-agents",
	"comp-ops",
	"comp-kill-dialog",
	"comp-definition-dialog",
	"comp-definition-error",
	"comp-new-agent",
	"state-empty",
	"state-offline",
];

describe("console storybook catalog", () => {
	test("covers pages, components, and states without duplicate ids", () => {
		const ids = STORIES.map((story) => story.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(STORIES.map((story) => story.group))).toEqual(
			new Set(["Pages", "Components", "States"]),
		);
		for (const id of REQUIRED_IDS) {
			expect(ids).toContain(id);
		}
	});

	test("every story has html painted by production classes", () => {
		for (const story of STORIES) {
			expect(story.title.length).toBeGreaterThan(0);
			expect(story.docs.length).toBeGreaterThan(0);
			expect(story.html.length).toBeGreaterThan(0);
		}
		const populated = STORIES.find((story) => story.id === "page-populated");
		expect(populated?.html).toContain('id="sidebar"');
		expect(populated?.html).toContain('id="ops"');
		expect(populated?.html).toContain('id="messages"');
		expect(populated?.html).toContain('id="thread"');
		expect(populated?.html).toContain('id="composer"');
	});
});

describe("console storybook server", () => {
	test("serves the workshop, production CSS, and a populated preview", async () => {
		const server = startStorybook(0);
		try {
			const origin = String(server.url).replace(/\/$/, "");
			const index = await fetch(`${origin}/`);
			expect(index.status).toBe(200);
			expect(await index.text()).toContain("oh-my-agent console storybook");

			const css = await fetch(`${origin}/style.css`);
			expect(css.status).toBe(200);
			expect(await css.text()).toContain("--surface-0");

			const preview = await fetch(`${origin}/preview.html?id=page-populated`);
			expect(preview.status).toBe(200);
			expect(await preview.text()).toContain("/stories.js");

			const missing = await fetch(`${origin}/nope`);
			expect(missing.status).toBe(404);
		} finally {
			await server.stop(true);
		}
	});
});
