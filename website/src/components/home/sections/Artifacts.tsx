import { FileCode2, MessageSquareText, MonitorPlay, RefreshCw } from "lucide-react";
import { Reveal, SectionHeader } from "../ui/primitives";

// README.md "Artifacts" and CHANGELOG.md 1.5.0 (lavish skill, console Artifacts view).
const STEPS = [
	{ icon: FileCode2, title: "A peer writes a page", body: "A plan, comparison, or report, written as an HTML artifact.", code: "skills: [lavish]" },
	{ icon: MonitorPlay, title: "It opens in Lavish Editor", body: "Workers run Lavish headless, so no window pops up on your desk.", code: "npx -y lavish-axi" },
	{ icon: MessageSquareText, title: "You annotate", body: "The console's Artifacts view lists every session with Open review.", code: "GET / POST /api/artifacts" },
	{ icon: RefreshCw, title: "The peer polls for feedback", body: "Your notes reach the peer against your own Lavish state.", code: "~/.lavish-axi" },
];

export default function Artifacts() {
	return (
		<section id="artifacts" className="section" aria-labelledby="artifacts-title">
			<div className="container">
				<SectionHeader
					index="04"
					eyebrow="Artifacts"
					title={<span id="artifacts-title">Review the work as a page, not a wall of chat.</span>}
					lead="Any peer can hand you a plan, comparison, or report. The default crew and every preset declare the lavish skill, so the review loop works out of the box."
					align="center"
				/>
				<ol className="loop">
					<span className="loop-ring" aria-hidden="true" />
					{STEPS.map((step, i) => {
						const Icon = step.icon;
						return (
							<Reveal as="li" key={step.title} className="loop-step" delay={i * 0.1}>
								<span className="loop-num" aria-hidden="true">
									{String(i + 1).padStart(2, "0")}
								</span>
								<span className="loop-icon" style={{ animationDelay: `${i * 1.5}s` }} aria-hidden="true">
									<Icon size={22} />
								</span>
								<h3>{step.title}</h3>
								<p>{step.body}</p>
								<code>{step.code}</code>
							</Reveal>
						);
					})}
				</ol>
			</div>
		</section>
	);
}
