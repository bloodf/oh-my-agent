"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { Check, Copy } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

// Counts up the first time it scrolls into view. Server markup and
// reduced-motion visitors get the final value, so the number is never wrong.
export function CountUp({ to, duration = 1.4, className = "" }: { to: number; duration?: number; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
	const reduce = useReducedMotion();
	const [value, setValue] = useState(to);
	const started = useRef(false);

	useEffect(() => {
		if (!inView || reduce || started.current) return undefined;
		started.current = true;
		const controls = animate(0, to, { duration, ease: EASE, onUpdate: setValue });
		return () => controls.stop();
	}, [inView, reduce, to, duration]);

	return (
		<span ref={ref} className={className}>
			{Math.round(value)}
		</span>
	);
}

type RevealTag = "div" | "li" | "p" | "article" | "header";

// Fade-and-rise on first view. MotionConfig reducedMotion="user" drops the movement.
export function Reveal({
	children,
	delay = 0,
	y = 22,
	as = "div",
	className = "",
}: {
	children: ReactNode;
	delay?: number;
	y?: number;
	as?: RevealTag;
	className?: string;
}) {
	const Tag = motion[as];
	return (
		<Tag
			className={className}
			initial={{ opacity: 0, y }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true, margin: "0px 0px -10% 0px" }}
			transition={{ duration: 0.8, delay, ease: EASE }}
		>
			{children}
		</Tag>
	);
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return undefined;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};

	return (
		<button type="button" className="copy-btn" onClick={copy} aria-label={copied ? "Copied" : `${label}: ${text}`}>
			{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
			<span aria-live="polite">{copied ? "Copied" : label}</span>
		</button>
	);
}

// Pointer position in CSS vars for the spotlight hover on cards.
export function spotlight(event: PointerEvent<HTMLElement>) {
	const rect = event.currentTarget.getBoundingClientRect();
	event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
	event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
}

export function SectionHeader({
	index,
	eyebrow,
	title,
	lead,
	align = "left",
}: {
	index: string;
	eyebrow: string;
	title: ReactNode;
	lead?: ReactNode;
	align?: "left" | "center";
}) {
	return (
		<Reveal as="header" className={`section-header is-${align}`}>
			<p className="eyebrow">
				<span className="eyebrow-index">{index}</span>
				{eyebrow}
			</p>
			<h2 className="section-title">{title}</h2>
			{lead ? <p className="section-lead">{lead}</p> : null}
		</Reveal>
	);
}

export function GitHubMark({ size = 18 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

// The brand conversation mark (docs/assets/mark.svg), drawn inline so it scales crisply.
export function BrandMark({ size = 28 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
			<rect width="128" height="128" rx="28" fill="#451b52" />
			<circle cx="61.5" cy="61.5" r="28" fill="none" stroke="#f8fafc" strokeWidth="14.5" />
			<path d="M80.5 82.25c8.5-2.25 14.25-7.5 17.5-14.75-.5 10.75-4.25 19.25-11.75 25.5l-5.75-10.75Z" fill="#f8fafc" />
			<circle cx="93" cy="35" r="6.75" fill="#7dd3fc" />
		</svg>
	);
}
