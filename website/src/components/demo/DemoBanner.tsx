"use client";

import { FlaskConical, RotateCcw } from "lucide-react";

/** A thin strip that says this is a mocked demo. */
export function DemoBanner() {
	const reset = async () => {
		const { resetDemo } = await import("@site/mock");
		resetDemo();
		location.replace("/console");
	};
	return (
		<div
			role="note"
			aria-label="Demo notice"
			className="flex h-[var(--demo-banner-height)] shrink-0 items-center gap-2 overflow-hidden border-b border-amber-500/30 bg-amber-100 px-3 text-[11px] text-amber-950 dark:bg-amber-950 dark:text-amber-100"
		>
			<FlaskConical className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">
				<strong className="font-semibold">Demo</strong>
				<span className="hidden sm:inline"> · the real console against a mocked daemon in your browser. Nothing leaves this tab.</span>
				<span className="sm:hidden"> · mocked data</span>
			</span>
				<span className="ml-auto flex shrink-0 items-center gap-1">
					<button id="demo-reset" type="button" onClick={() => void reset()} className="inline-flex h-6 items-center gap-1 rounded px-1.5 font-medium hover:bg-amber-200 dark:hover:bg-amber-900">
						<RotateCcw className="size-3" aria-hidden="true" />
						Reset demo data
					</button>
				</span>
		</div>
	);
}
