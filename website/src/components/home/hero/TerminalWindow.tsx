"use client";

import { motion, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { useState } from "react";

// Commands are the README quick start, verbatim. The window closes as the hero
// scrolls; the status line then reports that the daemon kept the crew running.
const LINES = [
	{ prompt: "$", text: "omp install @bloodf/oh-my-agent" },
	{ prompt: "$", text: "omp" },
	{ prompt: ">", text: "/setup" },
	{ prompt: ">", text: "/rooms post #bridge @mate add dark mode and fix the flaky login test" },
];

const clamp = (v: number) => Math.min(1, Math.max(0, v));

export default function TerminalWindow({ progress }: { progress: MotionValue<number> }) {
	const [closed, setClosed] = useState(false);
	useMotionValueEvent(progress, "change", (p) => setClosed(p > 0.36));

	const close = (p: number) => clamp((p - 0.18) / 0.22);
	const scale = useTransform(progress, (p) => 1 - close(p) * 0.22);
	const opacity = useTransform(progress, (p) => 1 - close(p));
	const y = useTransform(progress, (p) => close(p) * 40);
	const blur = useTransform(progress, (p) => `blur(${close(p) * 8}px)`);
	const toastOpacity = useTransform(progress, (p) => clamp((p - 0.36) / 0.1) * (1 - clamp((p - 0.82) / 0.12)));

	return (
		<div className="terminal-slot">
			<motion.div className="terminal" style={{ scale, opacity, y, filter: blur }} aria-hidden={closed}>
				<div className="terminal-bar">
					<span className="terminal-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
					<span className="terminal-title">omp — ~/projects/app</span>
				</div>
				<div className="terminal-body">
					{LINES.map((line, i) => (
						<p key={line.text} className="terminal-line" style={{ animationDelay: `${0.5 + i * 0.55}s` }}>
							<span className="terminal-prompt">{line.prompt}</span> {line.text}
						</p>
					))}
					<p className="terminal-line terminal-reply" style={{ animationDelay: "2.9s" }}>
						<span className="terminal-tag">#bridge</span> mate 👀 ⏳
					</p>
					<p className="terminal-line" style={{ animationDelay: "3.3s" }}>
						<span className="terminal-prompt">&gt;</span> <span className="terminal-cursor" />
					</p>
				</div>
			</motion.div>

			<motion.p className="terminal-toast" style={{ opacity: toastOpacity }} role="status">
				<span className="toast-dot" aria-hidden="true" />
				{closed ? "Terminal closed. The daemon is still running the crew." : "Session attached"}
			</motion.p>
		</div>
	);
}
