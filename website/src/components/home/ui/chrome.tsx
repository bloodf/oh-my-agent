"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ReactLenis } from "lenis/react";
import { MotionConfig, motion, useReducedMotion, useScroll, useSpring } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { BrandMark, GitHubMark } from "./primitives";
import { GITHUB_URL } from "../data";

export function SmoothScroll({ children }: { children: ReactNode }) {
	const reduce = useReducedMotion();
	const content = <MotionConfig reducedMotion="user">{children}</MotionConfig>;
	if (reduce) return content;
	return (
		<ReactLenis root options={{ lerp: 0.12, anchors: { offset: -72 }, autoRaf: true }}>
			{content}
		</ReactLenis>
	);
}

export function ScrollProgress() {
	const { scrollYProgress } = useScroll();
	const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 30, restDelta: 0.001 });
	return <motion.div className="scroll-progress" style={{ scaleX }} aria-hidden="true" />;
}

// Reads and writes the attribute the inline script in (home)/layout.tsx sets
// before first paint, so the toggle never flashes the wrong theme.
function ThemeToggle() {
	const [theme, setTheme] = useState<"dark" | "light">("dark");
	useEffect(() => {
		setTheme(document.documentElement.dataset.omaTheme === "light" ? "light" : "dark");
	}, []);

	const toggle = () => {
		const next = theme === "dark" ? "light" : "dark";
		document.documentElement.dataset.omaTheme = next;
		try {
			localStorage.setItem("oma-home-theme", next);
		} catch {
			// Private mode: the choice lasts for this page view only.
		}
		setTheme(next);
	};

	return (
		<button
			type="button"
			className="nav-icon"
			onClick={toggle}
			aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
		>
			{theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
		</button>
	);
}

const NAV_LINKS = [
	{ href: "#daemon", label: "Daemon" },
	{ href: "#rooms", label: "Rooms" },
	{ href: "#schedules", label: "Schedules" },
	{ href: "#isolation", label: "Isolation" },
	{ href: "#quick-start", label: "Quick start" },
];

export function Nav() {
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 24);
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<header className={`site-nav ${scrolled ? "is-scrolled" : ""}`}>
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<nav className="nav-inner" aria-label="Primary">
				<a href="#top" className="nav-brand" aria-label="oh-my-agent home">
					<BrandMark size={28} />
					<span>oh-my-agent</span>
				</a>
				<ul className="nav-links">
					{NAV_LINKS.map((link) => (
						<li key={link.href}>
							<a href={link.href}>{link.label}</a>
						</li>
					))}
				</ul>
				<div className="nav-actions">
					<ThemeToggle />
					<a className="nav-icon" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="oh-my-agent on GitHub">
						<GitHubMark size={18} />
					</a>
					<Link className="btn btn-small btn-primary" href="/console">
						Live demo
					</Link>
				</div>
			</nav>
		</header>
	);
}
