"use client";

import { FlaskConical, LogOut, RotateCcw } from "lucide-react";
import { DEMO_PASSWORD } from "@site/mock/demoPassword";
import { signOut } from "@site/mock/session";

/** A thin strip that says this is a mocked demo, on the login and console pages. */
export function DemoBanner({ variant }: { variant: "login" | "console" }) {
	const reset = async () => {
		const { resetDemo } = await import("@site/mock");
		resetDemo();
		location.replace("/console");
	};
	const logOut = () => {
		signOut();
		location.replace("/console/login");
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
			{variant === "login" ? (
				<span className="ml-auto shrink-0">
					Demo password: <code className="rounded bg-amber-200 px-1 font-mono font-semibold dark:bg-amber-900">{DEMO_PASSWORD}</code>
				</span>
			) : (
				<span className="ml-auto flex shrink-0 items-center gap-1">
					<button id="demo-reset" type="button" onClick={() => void reset()} className="inline-flex h-6 items-center gap-1 rounded px-1.5 font-medium hover:bg-amber-200 dark:hover:bg-amber-900">
						<RotateCcw className="size-3" aria-hidden="true" />
						Reset demo data
					</button>
					<button id="demo-logout" type="button" onClick={logOut} className="inline-flex h-6 items-center gap-1 rounded px-1.5 font-medium hover:bg-amber-200 dark:hover:bg-amber-900">
						<LogOut className="size-3" aria-hidden="true" />
						Log out
					</button>
				</span>
			)}
		</div>
	);
}
