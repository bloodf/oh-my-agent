import { BufferAttribute, BufferGeometry } from "three";

// Rooms drawn as constellations. Peer names are the default crew and two of the
// shipped presets (README.md "Quick start"); positions are artistic.
type Node = { name: string; pos: [number, number, number]; size: number };

export const NODES: Node[] = [
	{ name: "mate", pos: [0.2, 0.35, 0.4], size: 1.35 },
	{ name: "staff-pm", pos: [2.3, 1.2, -0.6], size: 0.95 },
	{ name: "staff-backend", pos: [3.4, -0.2, -0.2], size: 0.9 },
	{ name: "staff-frontend", pos: [2.2, -1.35, 0.3], size: 0.9 },
	{ name: "staff-qa", pos: [1.0, -0.9, -1.1], size: 0.85 },
	{ name: "researcher", pos: [-2.4, 1.1, -0.4], size: 0.9 },
	{ name: "reviewer", pos: [-3.2, -0.3, 0.2], size: 0.8 },
	{ name: "tech-writer", pos: [-1.6, -1.3, -0.8], size: 0.75 },
	{ name: "sre", pos: [-0.6, 2.0, -1.6], size: 0.7 },
];

// Index pairs: #bridge (mate to staff), #team (staff among themselves),
// a preset family room, and a few cross-room DMs.
export const EDGES: [number, number][] = [
	[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1],
	[0, 5], [5, 6], [6, 7], [7, 5], [0, 8], [8, 5], [3, 7], [2, 8],
];

const index = (i: number) => NODES[i].pos;

export function buildAgentGeometry() {
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new BufferAttribute(new Float32Array(NODES.flatMap((n) => n.pos)), 3));
	geometry.setAttribute("aSize", new BufferAttribute(new Float32Array(NODES.map((n) => n.size)), 1));
	geometry.setAttribute("aPhase", new BufferAttribute(new Float32Array(NODES.map((_, i) => i * 2.39)), 1));
	return geometry;
}

// Each edge is one line segment; aT runs 0..1 so the fragment shader can draw a travelling trail.
export function buildLinkGeometry() {
	const geometry = new BufferGeometry();
	const positions = EDGES.flatMap(([a, b]) => [...index(a), ...index(b)]);
	const t = EDGES.flatMap(() => [0, 1]);
	const phase = EDGES.flatMap((_, i) => [i * 0.37, i * 0.37]);
	geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
	geometry.setAttribute("aT", new BufferAttribute(new Float32Array(t), 1));
	geometry.setAttribute("aPhase", new BufferAttribute(new Float32Array(phase), 1));
	return geometry;
}

// Several packets per edge, both directions, so the rooms always look busy.
export function buildPacketGeometry(perEdge: number) {
	const start: number[] = [];
	const end: number[] = [];
	const offset: number[] = [];
	const speed: number[] = [];
	EDGES.forEach(([a, b], e) => {
		for (let k = 0; k < perEdge; k += 1) {
			const forward = (e + k) % 2 === 0;
			start.push(...index(forward ? a : b));
			end.push(...index(forward ? b : a));
			offset.push((e * 0.173 + k / perEdge) % 1);
			speed.push(0.09 + ((e * 7 + k * 3) % 5) * 0.025);
		}
	});
	const count = offset.length;
	const geometry = new BufferGeometry();
	// position is required by three for bounds; the shader ignores it.
	geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
	geometry.setAttribute("aStart", new BufferAttribute(new Float32Array(start), 3));
	geometry.setAttribute("aEnd", new BufferAttribute(new Float32Array(end), 3));
	geometry.setAttribute("aOffset", new BufferAttribute(new Float32Array(offset), 1));
	geometry.setAttribute("aSpeed", new BufferAttribute(new Float32Array(speed), 1));
	return geometry;
}
