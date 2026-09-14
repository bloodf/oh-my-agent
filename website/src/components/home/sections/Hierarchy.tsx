"use client";

import { motion } from "motion/react";
import ThreeStage from "../threeui/ThreeStage";
import { Reveal, SectionHeader } from "../ui/primitives";

// docs/guide/concepts.md "Hierarchy": parentage is spawn-time daemon state; a child
// inherits the parent's account and a #<parent>-team channel; kill cascades.
const NODES = [
	{ id: "mate", x: 200, y: 48, label: "mate", root: true },
	{ id: "backend", x: 90, y: 160, label: "staff-backend" },
	{ id: "qa", x: 310, y: 160, label: "staff-qa" },
	{ id: "migrator", x: 40, y: 272, label: "migrator" },
	{ id: "bench", x: 150, y: 272, label: "bench" },
	{ id: "flake", x: 310, y: 272, label: "flake-hunter" },
];
const LINKS: [string, string][] = [
	["mate", "backend"],
	["mate", "qa"],
	["backend", "migrator"],
	["backend", "bench"],
	["qa", "flake"],
];
const at = (id: string) => NODES.find((n) => n.id === id) ?? NODES[0];

const RULES = [
	{ code: "omp-agent spawn child --parent parent", body: "Parentage is a spawn argument, never frontmatter. The daemon records the edge." },
	{ code: "account + #<parent>-team", body: "A child inherits exactly two things: the parent's account and a family channel." },
	{ code: "kill <name> --keep-children", body: "kill cascades down the subtree by default; --keep-children reparents to root." },
	{ code: "OMA_REMOTE=1", body: "Remote mode refuses a worker spawn whose parent is not its authenticated identity." },
];

export default function Hierarchy() {
	return (
		<section id="hierarchy" className="section section-stage" aria-labelledby="hierarchy-title">
			<ThreeStage effect="orbital" className="stage-soft" speed={0.6} hue={-12} haloOpacity={0.3} orbitOpacity={0.3} />
			<div className="container split">
				<div>
					<SectionHeader
						index="03"
						eyebrow="Hierarchy"
						title={<span id="hierarchy-title">Agents hire agents. The daemon keeps the family tree.</span>}
						lead="Peers can author and deploy child peers. Parentage is enforced rather than taken from cooperative metadata, so kill stops a subtree together and a child whose parent is gone is never woken."
					/>
					<ul className="rule-list">
						{RULES.map((rule, i) => (
							<Reveal as="li" key={rule.code} className="rule" delay={i * 0.07}>
								<code>{rule.code}</code>
								<p>{rule.body}</p>
							</Reveal>
						))}
					</ul>
				</div>

				<Reveal className="tree-card" y={30}>
					<svg viewBox="0 0 400 320" className="tree" role="img" aria-label="Tree: mate is parent of staff-backend and staff-qa, which each spawned child peers">
						{LINKS.map(([a, b], i) => {
							const from = at(a);
							const to = at(b);
							const d = `M${from.x} ${from.y + 18} C${from.x} ${(from.y + to.y) / 2}, ${to.x} ${(from.y + to.y) / 2}, ${to.x} ${to.y - 18}`;
							return (
								<g key={`${a}-${b}`}>
									<motion.path
										d={d}
										className="tree-link"
										initial={{ pathLength: 0 }}
										whileInView={{ pathLength: 1 }}
										viewport={{ once: true }}
										transition={{ duration: 0.9, delay: 0.2 + i * 0.18, ease: "easeInOut" }}
									/>
									<path d={d} className="tree-packet" style={{ animationDelay: `${i * 0.6}s` }} pathLength={1} />
								</g>
							);
						})}
						{NODES.map((node, i) => (
							<motion.g
								key={node.id}
								initial={{ opacity: 0, scale: 0.6 }}
								whileInView={{ opacity: 1, scale: 1 }}
								viewport={{ once: true }}
								transition={{ duration: 0.5, delay: 0.1 + i * 0.12 }}
								style={{ transformOrigin: `${node.x}px ${node.y}px` }}
							>
								<circle cx={node.x} cy={node.y} r={node.root ? 16 : 12} className={`tree-node ${node.root ? "is-root" : ""}`} />
								<text x={node.x} y={node.y + (node.root ? 36 : 30)} className="tree-label" textAnchor="middle">
									{node.label}
								</text>
							</motion.g>
						))}
					</svg>
					<p className="tree-caption">Child names are examples; the family channel is created for you.</p>
				</Reveal>
			</div>
		</section>
	);
}
