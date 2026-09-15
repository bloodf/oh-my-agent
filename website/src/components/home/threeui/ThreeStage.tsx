"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentType } from "react";
import "@designcodeio/threeui/style.css";

// ThreeUI (MIT, @designcodeio/threeui). Only components that draw their own
// canvas are used; the iframe-based effects that pull CDNs are avoided. Each
// is code-split and fetched once its stage nears the viewport. They stop their
// own rAF loop off-screen and while the tab is hidden.
const EFFECTS = {
	stream: dynamic(
		() => import("@designcodeio/threeui/components/StreamConvergenceBackground").then((m) => m.StreamConvergenceBackground),
		{ ssr: false },
	),
	bell: dynamic(() => import("@designcodeio/threeui/components/BellFieldBackground").then((m) => m.BellFieldBackground), {
		ssr: false,
	}),
	orbital: dynamic(
		() => import("@designcodeio/threeui/components/OrbitalSphereBackground").then((m) => m.OrbitalSphereBackground),
		{ ssr: false },
	),
	warp: dynamic(() => import("@designcodeio/threeui/components/WarpFieldBackground").then((m) => m.WarpFieldBackground), {
		ssr: false,
	}),
	laser: dynamic(() => import("@designcodeio/threeui/components/LaserCollection").then((m) => m.LaserCollection), {
		ssr: false,
	}),
} satisfies Record<string, ComponentType<never>>;

export type ThreeEffect = keyof typeof EFFECTS;

function canRender() {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
		// Release the probe right away; browsers cap live contexts per page.
		gl?.getExtension("WEBGL_lose_context")?.loseContext();
		return Boolean(gl);
	} catch {
		return false;
	}
}

// Decorative WebGL backdrop. The CSS fallback is always painted underneath, so
// there is no layout shift and reduced-motion or no-WebGL visitors still get a
// themed surface. Unmounts again when far off-screen to free the GL context.
export default function ThreeStage({
	effect,
	className = "",
	...props
}: { effect: ThreeEffect; className?: string } & Record<string, unknown>) {
	const ref = useRef<HTMLDivElement>(null);
	const [live, setLive] = useState(false);
	const [shown, setShown] = useState(false);

	useEffect(() => {
		const node = ref.current;
		if (!node || !canRender()) return undefined;
		const observer = new IntersectionObserver(([entry]) => setLive(entry.isIntersecting), { rootMargin: "400px 0px" });
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!live) {
			setShown(false);
			return undefined;
		}
		const timer = setTimeout(() => setShown(true), 240);
		return () => clearTimeout(timer);
	}, [live]);

	const Effect = EFFECTS[effect] as ComponentType<Record<string, unknown>>;
	return (
		<div
			ref={ref}
			className={`three-stage is-${effect} ${shown ? "is-shown" : ""} ${className}`}
			data-live={live ? "true" : "false"}
			aria-hidden="true"
		>
			<div className="three-stage-fallback" />
			{live ? (
				<div className="three-stage-canvas">
					<Effect {...props} />
				</div>
			) : null}
		</div>
	);
}
