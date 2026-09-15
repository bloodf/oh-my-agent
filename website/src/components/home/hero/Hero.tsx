"use client";

import Link from "next/link";
import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { ArrowRight } from "lucide-react";
import HeroCanvas from "./HeroCanvas";
import TerminalWindow from "./TerminalWindow";
import { CopyButton, GitHubMark } from "../ui/primitives";
import { GITHUB_URL, INSTALL, VERSION } from "../data";

const HERO_ID = "top";
const EASE = [0.22, 1, 0.36, 1] as const;

const rise = (i: number) => ({
	initial: { opacity: 0, y: 26, filter: "blur(8px)" },
	animate: { opacity: 1, y: 0, filter: "blur(0px)" },
	transition: { duration: 0.9, delay: 0.1 + i * 0.1, ease: EASE },
});

export default function Hero() {
	const ref = useRef<HTMLElement>(null);
	const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
	const contentOpacity = useTransform(scrollYProgress, [0.55, 0.85], [1, 0]);
	const contentY = useTransform(scrollYProgress, [0.55, 0.85], [0, -60]);
	const cueOpacity = useTransform(scrollYProgress, [0, 0.08], [1, 0]);
	const underline = useTransform(scrollYProgress, [0.25, 0.5], [0, 1]);

	return (
		<section id={HERO_ID} ref={ref} className="hero" aria-labelledby="hero-title">
			<div className="hero-sticky">
				<HeroCanvas heroId={HERO_ID} />
				<div className="hero-shade" aria-hidden="true" />

				<motion.div className="hero-grid container" style={{ opacity: contentOpacity, y: contentY }}>
					<div className="hero-copy">
						<motion.p className="hero-kicker" {...rise(0)}>
							<span className="kicker-dot" aria-hidden="true" />
							OMP plugin · MIT · v{VERSION}
						</motion.p>

						<h1 id="hero-title" className="hero-title">
							<motion.span className="hero-line" {...rise(1)}>
								Close the terminal.
							</motion.span>
							<motion.span className="hero-line hero-line-accent" {...rise(2)}>
								The agents keep talking.
								<motion.span className="hero-underline" style={{ scaleX: underline }} aria-hidden="true" />
							</motion.span>
						</h1>

						<motion.p className="hero-sub" {...rise(3)}>
							oh-my-agent runs long-lived OMP agents as a local daemon. They keep working after the TUI closes, talk to
							each other in persistent rooms, and stay observable from the TUI, the CLI, or a browser console.
						</motion.p>

						<motion.div className="hero-ctas" {...rise(4)}>
							<Link href="/console" className="btn btn-primary btn-large">
								Try the console demo
								<ArrowRight size={18} aria-hidden="true" />
							</Link>
							<div className="install-pill" role="group" aria-label="Install command">
								<span className="install-prompt" aria-hidden="true">
									$
								</span>
								<code>{INSTALL}</code>
								<CopyButton text={INSTALL} label="Copy" />
							</div>
						</motion.div>

						<motion.a className="hero-github" href={GITHUB_URL} target="_blank" rel="noreferrer" {...rise(5)}>
							<GitHubMark size={16} />
							bloodf/oh-my-agent on GitHub
						</motion.a>
					</div>

					<motion.div className="hero-terminal" {...rise(3)}>
						<TerminalWindow progress={scrollYProgress} />
					</motion.div>
				</motion.div>

				<motion.div className="scroll-cue" style={{ opacity: cueOpacity }} aria-hidden="true">
					<span>Scroll to close the session</span>
					<span className="scroll-cue-line" />
				</motion.div>
			</div>
		</section>
	);
}
