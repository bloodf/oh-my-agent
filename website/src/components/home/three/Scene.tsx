"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdditiveBlending, type Group, Vector2 } from "three";
import { agentFragment, agentVertex, linkFragment, linkVertex, packetFragment, packetVertex } from "@site/shaders/agents";
import { nightFragment, nightVertex } from "@site/shaders/night";
import { buildAgentGeometry, buildLinkGeometry, buildPacketGeometry } from "./constellation";

const STILL_TIME = 11;
const pointer = new Vector2();
type Input = { x: number; y: number; progress: number };
type Uniforms = {
	uTime: { value: number };
	uWake: { value: number };
	uPixelRatio: { value: number };
	uResolution: { value: Vector2 };
	uPointer: { value: Vector2 };
};

// Pointer and hero scroll progress kept in a ref so the render loop never re-renders React.
function useHeroInput(heroId: string) {
	const input = useRef<Input>({ x: 0, y: 0, progress: 0 });
	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			input.current.x = (event.clientX / window.innerWidth) * 2 - 1;
			input.current.y = -(event.clientY / window.innerHeight) * 2 + 1;
		};
		const onScroll = () => {
			const hero = document.getElementById(heroId);
			if (!hero) return;
			const rect = hero.getBoundingClientRect();
			input.current.progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height - window.innerHeight)));
		};
		onScroll();
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("scroll", onScroll);
		};
	}, [heroId]);
	return input;
}

function Night({ uniforms }: { uniforms: Uniforms }) {
	return (
		<mesh frustumCulled={false} renderOrder={-1}>
			<planeGeometry args={[2, 2]} />
			<shaderMaterial
				vertexShader={nightVertex}
				fragmentShader={nightFragment}
				uniforms={uniforms}
				depthWrite={false}
				depthTest={false}
			/>
		</mesh>
	);
}

function Constellation({ uniforms, heroId, still, packets }: { uniforms: Uniforms; heroId: string; still: boolean; packets: number }) {
	const group = useRef<Group>(null);
	const input = useHeroInput(heroId);
	const camera = useThree((s) => s.camera);
	const size = useThree((s) => s.size);
	const dpr = useThree((s) => s.viewport.dpr);
	const geometry = useMemo(
		() => ({ agents: buildAgentGeometry(), links: buildLinkGeometry(), packets: buildPacketGeometry(packets) }),
		[packets],
	);
	useEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);

	useFrame((_, delta) => {
		const dt = Math.min(delta, 0.05);
		const k = still ? 1 : 1 - Math.exp(-dt * 3);
		const src = input.current;
		const aspect = size.width / Math.max(1, size.height);
		uniforms.uTime.value = still ? STILL_TIME : uniforms.uTime.value + dt;
		uniforms.uPixelRatio.value = dpr;
		uniforms.uResolution.value.set(size.width * dpr, size.height * dpr);
		uniforms.uPointer.value.lerp(pointer.set(src.x, src.y), k);
		// The terminal closes around progress 0.4; the agents brighten after it.
		const wake = still ? 0.9 : 0.55 + 0.45 * Math.min(1, Math.max(0, (src.progress - 0.3) / 0.3));
		uniforms.uWake.value += (wake - uniforms.uWake.value) * k;

		const portrait = aspect < 1;
		const targetZ = (portrait ? 13.5 / Math.max(aspect, 0.5) : 9.5) - src.progress * 2.2;
		camera.position.x += ((still ? 0 : src.x * 0.5) - camera.position.x) * k;
		camera.position.y += ((still ? 0 : src.y * 0.3) + (portrait ? -1.6 : 0) - camera.position.y) * k;
		camera.position.z += (targetZ - camera.position.z) * k;
		camera.lookAt(0, portrait ? -1.6 : 0, 0);
		if (group.current) {
			const drift = still ? 0.2 : uniforms.uTime.value * 0.04;
			group.current.rotation.y = drift + src.progress * 0.7;
			group.current.position.x = aspect > 1.2 ? 1.6 * (1 - src.progress) : 0;
		}
	});

	const shared = { uniforms, transparent: true, depthWrite: false, blending: AdditiveBlending } as const;
	return (
		<group ref={group}>
			<lineSegments geometry={geometry.links}>
				<shaderMaterial vertexShader={linkVertex} fragmentShader={linkFragment} {...shared} />
			</lineSegments>
			<points geometry={geometry.packets} frustumCulled={false}>
				<shaderMaterial vertexShader={packetVertex} fragmentShader={packetFragment} {...shared} />
			</points>
			<points geometry={geometry.agents}>
				<shaderMaterial vertexShader={agentVertex} fragmentShader={agentFragment} {...shared} />
			</points>
		</group>
	);
}

// Pause rendering whenever the hero is scrolled out of view.
function useVisible(heroId: string) {
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		const hero = document.getElementById(heroId);
		if (!hero) return undefined;
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
		observer.observe(hero);
		return () => observer.disconnect();
	}, [heroId]);
	return visible;
}

export default function Scene({
	heroId,
	still = false,
	onReady,
	onLost,
}: { heroId: string; still?: boolean; onReady?: () => void; onLost?: () => void }) {
	const visible = useVisible(heroId);
	const uniforms = useMemo<Uniforms>(
		() => ({
			uTime: { value: 0 },
			uWake: { value: 0.55 },
			uPixelRatio: { value: 1 },
			uResolution: { value: new Vector2(1, 1) },
			uPointer: { value: new Vector2(0, 0) },
		}),
		[],
	);
	const small = typeof window !== "undefined" && window.innerWidth < 720;

	return (
		<Canvas
			dpr={[1, 1.75]}
			frameloop={still ? "demand" : visible ? "always" : "never"}
			gl={{ antialias: true, powerPreference: "high-performance", alpha: false, stencil: false }}
			camera={{ fov: 42, position: [0, 0, 9.5], near: 0.1, far: 60 }}
			onCreated={({ gl }) => {
				gl.domElement.addEventListener("webglcontextlost", () => onLost?.(), { once: true });
				onReady?.();
			}}
			aria-hidden="true"
		>
			<Night uniforms={uniforms} />
			<Constellation uniforms={uniforms} heroId={heroId} still={still} packets={small ? 2 : 3} />
		</Canvas>
	);
}
