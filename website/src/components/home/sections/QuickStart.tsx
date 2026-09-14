"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { CopyButton, Reveal, SectionHeader } from "../ui/primitives";
import { DOCS, QUICK_START } from "../data";

// WAI-ARIA tabs: arrow keys, Home and End move between install paths.
function Tabs() {
	const [active, setActive] = useState(0);
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	const current = QUICK_START[active];

	const onKeyDown = (event: KeyboardEvent) => {
		const last = QUICK_START.length - 1;
		const moves: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: last };
		if (!(event.key in moves)) return;
		event.preventDefault();
		const next = (moves[event.key] + QUICK_START.length) % QUICK_START.length;
		setActive(next);
		tabs.current[next]?.focus();
	};

	return (
		<div className="tabs">
			<div className="tab-list" role="tablist" aria-label="Install path" onKeyDown={onKeyDown}>
				{QUICK_START.map((tab, i) => (
					<button
						key={tab.id}
						ref={(node) => {
							tabs.current[i] = node;
						}}
						type="button"
						role="tab"
						id={`qs-tab-${tab.id}`}
						aria-selected={i === active}
						aria-controls={`qs-panel-${tab.id}`}
						tabIndex={i === active ? 0 : -1}
						className={`tab ${i === active ? "is-active" : ""}`}
						onClick={() => setActive(i)}
					>
						{i === active ? <motion.span layoutId="qs-pill" className="tab-pill" /> : null}
						<span className="tab-text">{tab.label}</span>
					</button>
				))}
			</div>
			<div className="code-block" role="tabpanel" id={`qs-panel-${current.id}`} aria-labelledby={`qs-tab-${current.id}`}>
				<div className="code-bar">
					<span className="code-label">{current.note}</span>
					<CopyButton text={current.lines.join("\n")} label="Copy all" />
				</div>
				<AnimatePresence mode="wait" initial={false}>
					<motion.pre
						key={current.id}
						tabIndex={0}
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: -6 }}
						transition={{ duration: 0.2 }}
					>
						<code>
							{current.lines.map((line) => (
								<span key={line} className="code-line">
									<span className="c-dim">{line.startsWith("/") ? "> " : "$ "}</span>
									{line}
									{"\n"}
								</span>
							))}
						</code>
					</motion.pre>
				</AnimatePresence>
			</div>
		</div>
	);
}

export default function QuickStart() {
	return (
		<section id="quick-start" className="section" aria-labelledby="qs-title">
			<div className="container split">
				<div>
					<SectionHeader
						index="10"
						eyebrow="Quick start"
						title={<span id="qs-title">Two commands to a crew that stays up.</span>}
						lead={
							<>
								Run <code>/setup</code> inside <code>omp</code> for a ✓/✗ checklist with the fix on every ✗ line. The default
								crew runs on whatever model you picked as OMP&apos;s default, so nothing needs configuring first.
							</>
						}
					/>
					<Reveal>
						<a className="text-link" href={DOCS.gettingStarted} target="_blank" rel="noreferrer">
							Getting started guide <ArrowUpRight size={14} aria-hidden="true" />
						</a>
					</Reveal>
				</div>
				<Reveal y={30}>
					<Tabs />
				</Reveal>
			</div>
		</section>
	);
}
