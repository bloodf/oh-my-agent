import { CountUp, Reveal, SectionHeader } from "../ui/primitives";
import { DEFAULT_CREW, PRESETS } from "../data";

// Lifetimes from docs/guide/concepts.md: a native task lives for this run only;
// a peer survives restarts, parks when idle, and wakes on a mention or room traffic.
const LANES = [
	{ id: "tui", label: "OMP TUI session", note: "you close it", segments: [{ from: 0, to: 44, kind: "session" }] },
	{ id: "task", label: "Native task agent", note: "dies with the run", segments: [{ from: 6, to: 44, kind: "task" }] },
	{
		id: "peer",
		label: "oh-my-agent peer",
		note: "owned by the daemon",
		segments: [
			{ from: 6, to: 62, kind: "peer" },
			{ from: 62, to: 78, kind: "parked" },
			{ from: 78, to: 100, kind: "peer" },
		],
	},
];

export default function Daemon() {
	return (
		<section id="daemon" className="section" aria-labelledby="daemon-title">
			<div className="container">
				<SectionHeader
					index="01"
					eyebrow="The daemon"
					title={<span id="daemon-title">Close the terminal. The work continues.</span>}
					lead="OMP task agents live inside the interactive session. Close the TUI, they die. oh-my-agent is the process that does not: a local Bun daemon owns workers, rooms, and schedules, and every surface is a client of it."
				/>

				<Reveal className="lifetime" y={30}>
					<div className="lifetime-axis" aria-hidden="true">
						<span className="lifetime-close" style={{ left: "44%" }}>
							<span>TUI closed</span>
						</span>
						<span className="lifetime-wake" style={{ left: "78%" }}>
							<span>@mention wakes it</span>
						</span>
						<span className="lifetime-sweep" />
					</div>
					<ul className="lifetime-lanes">
						{LANES.map((lane) => (
							<li key={lane.id} className={`lane lane-${lane.id}`}>
								<div className="lane-label">
									<strong>{lane.label}</strong>
									<span>{lane.note}</span>
								</div>
								<div className="lane-track" aria-hidden="true">
									{lane.segments.map((seg) => (
										<span
											key={`${seg.kind}-${seg.from}`}
											className={`lane-seg seg-${seg.kind}`}
											style={{ left: `${seg.from}%`, width: `${seg.to - seg.from}%` }}
										/>
									))}
								</div>
							</li>
						))}
					</ul>
					<p className="lifetime-caption">
						A parked peer is idle, not dead. The daemon resumes it on an <code>@mention</code> or when a subscribed room gets
						traffic.
					</p>
				</Reveal>

				<ul className="stat-row">
					<Reveal as="li" className="stat" delay={0.05}>
						<CountUp to={DEFAULT_CREW.length} className="stat-value" />
						<span className="stat-label">crew peers start on first boot: mate plus four staff</span>
					</Reveal>
					<Reveal as="li" className="stat" delay={0.12}>
						<CountUp to={PRESETS.length} className="stat-value" />
						<span className="stat-label">role presets ship unseeded, ready to copy</span>
					</Reveal>
					<Reveal as="li" className="stat" delay={0.19}>
						<span className="stat-value">0</span>
						<span className="stat-label">cloud components. One operator, one daemon, your machine</span>
					</Reveal>
				</ul>
			</div>
		</section>
	);
}
