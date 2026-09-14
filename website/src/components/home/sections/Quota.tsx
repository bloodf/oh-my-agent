"use client";

import { useRef, useState } from "react";
import { motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { Reveal, SectionHeader } from "../ui/primitives";

// docs/guide/concepts.md "Quota": metered accounts warn at 80% of budgetUsd and
// park at 100% until `omp-agent bump <account> <usd>`; subscriptions park on
// quota-exhaustion and auto-resume at the provider reset.
type Phase = "running" | "warned" | "parked" | "bumped";

const STATUS: Record<Phase, { label: string; line: string }> = {
	running: { label: "running", line: "Spending inside autonomy.budgetUsd." },
	warned: { label: "warning posted", line: "80% of budgetUsd: a warning is posted to a room." },
	parked: { label: "parked", line: "100%: the peer parks until a human raises the ceiling." },
	bumped: { label: "resumed", line: "bump raised the ceiling and resumed the parked peers." },
};

export default function Quota() {
	const ref = useRef<HTMLDivElement>(null);
	const { scrollYProgress } = useScroll({ target: ref, offset: ["start 95%", "start 15%"] });
	const fill = useTransform(scrollYProgress, [0, 1], [0.08, 1]);
	const width = useTransform(fill, (f) => `${f * 100}%`);
	const [spent, setSpent] = useState(8);
	const [bumped, setBumped] = useState(false);

	useMotionValueEvent(fill, "change", (f) => {
		const next = Math.round(f * 100);
		setSpent(next);
		if (next < 60) setBumped(false);
	});

	const phase: Phase = bumped ? "bumped" : spent >= 100 ? "parked" : spent >= 80 ? "warned" : "running";
	const status = STATUS[phase];

	return (
		<section id="quota" className="section" aria-labelledby="quota-title">
			<div className="container split">
				<SectionHeader
					index="06"
					eyebrow="Quota handling"
					title={<span id="quota-title">Autonomy with a ceiling a human controls.</span>}
					lead="Long-lived agents should not quietly drain an account. Metered accounts warn, then park; subscription accounts park on quota exhaustion and auto-resume at the reset, with no human in the loop."
				/>

				<Reveal className={`meter-card is-${phase}`} y={30}>
					<div ref={ref} className="meter-head">
						<span className="meter-account">anthropic · metered</span>
						<span className={`meter-badge badge-${phase}`} aria-live="polite">
							{status.label}
						</span>
					</div>
					<div
						className="meter"
						role="meter"
						aria-label="Share of budgetUsd spent"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={bumped ? 60 : spent}
					>
						<motion.span className="meter-fill" style={{ width: bumped ? "60%" : width }} />
						<span className="meter-mark" style={{ left: "80%" }}>
							<span>80% warn</span>
						</span>
						<span className="meter-mark is-park" style={{ left: "100%" }}>
							<span>100% park</span>
						</span>
					</div>
					<p className="meter-line">{status.line}</p>
					<div className="meter-cli">
						<code>
							<span className="c-dim">$</span> omp-agent bump anthropic 5
						</code>
						<button type="button" className="btn btn-small btn-ghost" disabled={phase !== "parked"} onClick={() => setBumped(true)}>
							{phase === "parked" ? "Run bump" : phase === "bumped" ? "Resumed" : "Scroll to park"}
						</button>
					</div>
					<p className="fine-print">
						Scroll drives the illustration. <code>&lt;usd&gt;</code> must be a positive finite number; zero and negative
						values are refused.
					</p>
				</Reveal>
			</div>
		</section>
	);
}
