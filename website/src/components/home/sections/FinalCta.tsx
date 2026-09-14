"use client";

import { useState } from "react";
import { LumenCta } from "@designcodeio/threeui/components/LumenCta";
import "@designcodeio/threeui/style.css";
import { GITHUB_URL, INSTALL } from "../data";
import { GitHubMark } from "../ui/primitives";

export default function FinalCta() {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(INSTALL);
			setCopied(true);
			setTimeout(() => setCopied(false), 1800);
		} catch {
			setCopied(false);
		}
	};

	return (
		<section className="final" aria-labelledby="final-title">
			<div className="final-sky" aria-hidden="true">
				{Array.from({ length: 14 }, (_, i) => (
					<span key={i} className="final-star" style={{ ["--i" as string]: i, top: `${12 + ((i * 37) % 70)}%` }} />
				))}
			</div>
			<div className="container final-inner">
				<h2 id="final-title" className="final-title">
					Let them work the night shift.
				</h2>
				<p className="final-lead">
					<code>{INSTALL}</code>
				</p>
				<div className="final-actions">
					{/* ThreeUI LumenCta: a real button, so it copies rather than navigates. */}
					<LumenCta label={copied ? "Copied to clipboard" : "Copy install command"} hue={-60} onClick={copy} className="final-lumen" />
					<a className="btn btn-ghost btn-large" href={GITHUB_URL} target="_blank" rel="noreferrer">
						<GitHubMark size={18} /> Star on GitHub
					</a>
				</div>
				<p className="sr-only" aria-live="polite">
					{copied ? "Install command copied" : ""}
				</p>
			</div>
		</section>
	);
}
