"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const Scene = dynamic(() => import("../three/Scene"), { ssr: false });

function hasWebGL() {
	try {
		const canvas = document.createElement("canvas");
		return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
	} catch {
		return false;
	}
}

// Mounts the WebGL constellation after hydration. The CSS star field under it
// is always painted, so the hero never shifts and still reads without WebGL.
// Reduced motion gets a single still frame instead of the render loop.
export default function HeroCanvas({ heroId }: { heroId: string }) {
	const [mode, setMode] = useState<"pending" | "none" | "live" | "still">("pending");
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!hasWebGL()) {
			setMode("none");
			return undefined;
		}
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setMode(query.matches ? "still" : "live");
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return (
		<div className="hero-stage" aria-hidden="true">
			<div className="hero-fallback">
				<span className="hero-fallback-stars" />
			</div>
			{mode === "live" || mode === "still" ? (
				<div className={`hero-canvas ${ready ? "is-ready" : ""}`} data-mode={mode}>
					<Scene key={mode} heroId={heroId} still={mode === "still"} onReady={() => setReady(true)} />
				</div>
			) : null}
		</div>
	);
}
