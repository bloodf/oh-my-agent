import { ShieldCheck, GitMerge, Signpost } from "lucide-react";
import ThreeStage from "../threeui/ThreeStage";
import { Reveal, SectionHeader } from "../ui/primitives";

// ARCHITECTURE.md §7: three layers, in decreasing strength. Deliberately blunt.
const LAYERS = [
	{
		icon: ShieldCheck,
		name: "OS-level sandbox",
		tag: "Opt-in · fails closed",
		strength: 100,
		body: "sandbox: true wraps the worker subprocess in macOS Seatbelt or Linux bwrap. Model traffic goes through a per-worker gateway on loopback; a missing bridge fails closed instead of granting network.",
	},
	{
		icon: GitMerge,
		name: "Write isolation",
		tag: "On by default · mergeability, not security",
		strength: 60,
		body: "OMP task isolation gives delegated coding subagents copy-on-write workspaces and controlled merge-back. It does not restrict reads by itself.",
	},
	{
		icon: Signpost,
		name: "Convention scoping",
		tag: "On by default · soft, bypassable",
		strength: 28,
		body: "Tool allowlists, generated worker config, and system instructions reduce accidents when the sandbox is off. They are never described as security isolation.",
	},
];

export default function Isolation() {
	return (
		<section id="isolation" className="section section-stage" aria-labelledby="isolation-title">
			<ThreeStage effect="laser" className="stage-soft stage-edge" variant="vanishing-array" speed={0.6} hue={-160} opacity={0.55} />
			<div className="container">
				<SectionHeader
					index="07"
					eyebrow="Isolation"
					title={<span id="isolation-title">Three layers, named for what they really are.</span>}
					lead={
						<>
							Each worker gets a private root of allowed definitions. <code>workspace:</code> is a cwd, not a security
							boundary: it scopes defaults, not access.
						</>
					}
				/>
				<ol className="layers">
					{LAYERS.map((layer, i) => {
						const Icon = layer.icon;
						return (
							<Reveal as="li" key={layer.name} className="layer" delay={i * 0.1}>
								<span className="layer-rank" aria-hidden="true">
									{i + 1}
								</span>
								<div className="layer-main">
									<p className="layer-tag">{layer.tag}</p>
									<h3>
										<Icon size={20} aria-hidden="true" /> {layer.name}
									</h3>
									<p>{layer.body}</p>
								</div>
								<div className="layer-strength" aria-label={`Relative strength: layer ${i + 1} of 3`}>
									<span style={{ width: `${layer.strength}%` }} />
								</div>
							</Reveal>
						);
					})}
				</ol>
				<p className="fine-print">
					Check each peer&apos;s real state with <code>omp-agent --json agents</code>: the <code>sandboxed</code> field is
					carried on the wire.
				</p>
			</div>
		</section>
	);
}
