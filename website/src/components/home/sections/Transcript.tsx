"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";

// Illustrative only: the opening request is the README example; the replies
// show the delegation shape the README describes for mate. Reactions follow
// CHANGELOG 1.4.0 (👀 delivered, ⏳ running, ✅ done).
const MESSAGES = [
	{ room: "#bridge", author: "you", body: "@mate add dark mode and fix the flaky login test", reactions: "👀 ⏳" },
	{ room: "#team", author: "mate", body: "@staff-frontend dark mode is yours. @staff-qa take the flaky login test.", reactions: "👀" },
	{ room: "#team", author: "staff-qa", body: "Reproduced the flake. Evidence is in the thread.", reactions: "✅" },
	{ room: "#team", author: "staff-frontend", body: "Dark mode is up for review.", reactions: "✅" },
	{ room: "#bridge", author: "mate", body: "Both done and checked against the evidence. Summary below.", reactions: "✅" },
];

const STEP_MS = 1700;

export default function Transcript() {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { margin: "0px 0px -15% 0px" });
	const reduce = useReducedMotion();
	const [count, setCount] = useState(MESSAGES.length);

	useEffect(() => {
		if (reduce) return undefined;
		setCount(1);
	}, [reduce]);

	useEffect(() => {
		if (!inView || reduce) return undefined;
		const timer = setInterval(() => setCount((c) => (c >= MESSAGES.length + 2 ? 1 : c + 1)), STEP_MS);
		return () => clearInterval(timer);
	}, [inView, reduce]);

	const shown = MESSAGES.slice(0, Math.min(count, MESSAGES.length));
	return (
		<div ref={ref} className="transcript" role="group" aria-label="Illustrative room transcript">
			<p className="transcript-head">
				<span className="live-dot" aria-hidden="true" /> Illustrative transcript
			</p>
			<ol className="transcript-list">
				<AnimatePresence initial={false}>
					{shown.map((m) => (
						<motion.li
							key={m.body}
							className={`msg ${m.author === "you" ? "is-you" : ""}`}
							initial={{ opacity: 0, y: 14, scale: 0.98 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
						>
							<span className="msg-avatar" aria-hidden="true">
								{m.author.slice(0, 1)}
							</span>
							<div className="msg-main">
								<p className="msg-meta">
									<strong>@{m.author}</strong>
									<span>{m.room}</span>
								</p>
								<p className="msg-body">{m.body}</p>
								<p className="msg-reactions">{m.reactions}</p>
							</div>
						</motion.li>
					))}
				</AnimatePresence>
			</ol>
		</div>
	);
}
