"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const Scene = dynamic(() => import("../three/Scene"), { ssr: false });

function hasWebGL() {
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

// Mounts the WebGL constellation after hydration. The CSS star field under it
// is always painted, so the hero never shifts and still reads without WebGL.
// Reduced motion gets a single still frame instead of the render loop. A lost
// context (GPU reset, too many pages) drops back to the CSS star field.
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
					<Scene
						key={mode}
						heroId={heroId}
						still={mode === "still"}
						onReady={() => setReady(true)}
						onLost={() => setMode("none")}
					/>
				</div>
			) : null}
		</div>
	);
}
