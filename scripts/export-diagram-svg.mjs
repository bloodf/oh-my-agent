#!/usr/bin/env node
/**
 * Extract the Archify diagram SVG from a rendered HTML artifact, inline
 * dark-theme CSS so GitHub markdown can display it, and write a standalone
 * .svg. Intermediate HTML stays outside tracked documentation.
 *
 * Usage: node scripts/export-diagram-svg.mjs <input.html> <output.svg>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [htmlPath, svgPath] = process.argv.slice(2);
if (!htmlPath || !svgPath) {
	console.error(
		"usage: node scripts/export-diagram-svg.mjs <input.html> <output.svg>",
	);
	process.exit(2);
}

const html = readFileSync(htmlPath, "utf8");
const svgStart = html.search(/<svg\b[^>]*\sdata-quality-profile="[^"]+"[^>]*>/);
if (svgStart < 0) {
	console.error("no data-quality-profile SVG found in", htmlPath);
	process.exit(1);
}
const svgEnd = html.indexOf("</svg>", svgStart);
if (svgEnd < 0) {
	console.error("unclosed diagram SVG in", htmlPath);
	process.exit(1);
}
let svg = html.slice(svgStart, svgEnd + "</svg>".length);

const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
const rawCss = styleMatch ? styleMatch[1] : "";

const keep = [];
for (const block of rawCss.split(/\/\*[\s\S]*?\*\//)) {
	keep.push(block);
}
const css = keep.join("\n");

const varBlock = `svg,
    [data-theme="dark"] {
      --bg: #09090b;
      --grid: #27272a;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-dim: #71717a;
      --text-faint: #71717a;
      --panel: rgba(24, 24, 27, 0.92);
      --panel-border: #3f3f46;
      --lane-fill: rgba(39, 39, 42, 0.34);
      --lane-stroke: #52525b;
      --arrow: #71717a;
      --arrow-emphasis: #38bdf8;
      --mask: #18181b;
      --frontend-fill: rgba(14, 116, 144, 0.28);
      --frontend-stroke: #38bdf8;
      --backend-fill: rgba(49, 46, 129, 0.24);
      --backend-stroke: #818cf8;
      --database-fill: rgba(88, 28, 135, 0.24);
      --database-stroke: #c084fc;
      --cloud-fill: rgba(161, 98, 7, 0.24);
      --cloud-stroke: #fbbf24;
      --security-fill: rgba(159, 18, 57, 0.24);
      --security-stroke: #fb7185;
      --messagebus-fill: rgba(43, 24, 47, 0.72);
      --messagebus-stroke: #d8b4fe;
      --external-fill: rgba(63, 63, 70, 0.46);
      --external-stroke: #a1a1aa;
      --toolbar-bg: rgba(24, 24, 27, 0.92);
      --toolbar-border: #3f3f46;
      --toolbar-text: #e4e4e7;
      --toolbar-hover: #27272a;
      --toolbar-menu-bg: #18181b;
    }`;

const classRules = [];
for (const rule of css.matchAll(
	/(?:^|\n)\s*((?:svg[^{,]+,\s*)*(?:\.[a-zA-Z][\w-]*|svg)[^{]*\{[\s\S]*?\})/g,
)) {
	const text = rule[1];
	if (
		/\.(?:c|a|n|t|m|l|card)-|svg\[data-preset|marker|\.c-region|\.c-lane|\.c-security/.test(
			text,
		)
	) {
		classRules.push(text);
	}
}

const extra = `
svg { background: #09090b; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
${varBlock}
${classRules.join("\n")}
`;

svg = svg.replace(
	/<svg\b/,
	'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
);
if (!/\sxmlns=/.test(svg.slice(0, 200))) {
	svg = svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
}
svg = svg.replace(">", `>\n  <style><![CDATA[\n${extra}\n]]></style>\n`);

writeFileSync(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
console.log(JSON.stringify({ ok: true, bytes: svg.length, output: svgPath }));
