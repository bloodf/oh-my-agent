"use client";
/**
 * Purpose: The one client island a Markdown body may need: a mermaid fence
 * drawn in the browser, with the renderer imported on first sight.
 */
import { useEffect, useId, useState } from "react";

export function Mermaid({ source }: { source: string }) {
	const id = useId().replace(/[^a-zA-Z0-9]/g, "");
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void import("mermaid")
			.then(async ({ default: mermaid }) => {
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: "dark",
				});
				const rendered = await mermaid.render(`mmd-${id}`, source);
				if (!cancelled) setSvg(rendered.svg);
			})
			.catch((cause) => {
				if (!cancelled)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [source, id]);
	if (error !== null) {
		return (
			<div>
				<pre className="my-1.5 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-xs">
					{source}
				</pre>
				<p role="alert" className="text-xs text-red-400">
					diagram did not render: {error.split("\n")[0]}
				</p>
			</div>
		);
	}
	if (svg === null)
		return (
			<div
				className="my-1.5 h-16 animate-pulse rounded-lg bg-zinc-900/60"
				aria-busy="true"
			/>
		);
	// mermaid's own SVG from text it parsed under securityLevel strict; the
	// message body itself never reaches this prop.
	return (
		<div
			className="my-1.5 overflow-x-auto"
			data-diagram="mermaid"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by mermaid from parsed text, not author HTML
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
