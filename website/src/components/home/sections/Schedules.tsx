import ThreeStage from "../threeui/ThreeStage";
import { Reveal, SectionHeader } from "../ui/primitives";

// docs/guide/agents.md: schedules run in UTC; heartbeat { every } of at least 10s;
// default crew and presets declare every: "30m". README: one-shot timers persist too.
const HOURS = Array.from({ length: 25 }, (_, h) => h);
const HEARTBEATS = Array.from({ length: 48 }, (_, i) => i / 2);

const CARDS = [
	{ kind: "cron", code: 'cron: "0 9 * * 1-5"', body: "Fires at 09:00 UTC on weekdays and posts its prompt into a room, which may wake subscribers." },
	{ kind: "heartbeat", code: 'heartbeat: { every: "30m" }', body: "A running peer gets a standing turn: read rooms and plans, continue unfinished work, or answer idle." },
	{ kind: "once", code: "one-shot timer", body: "Fires once and is persisted in SQLite, so a daemon restart does not lose it." },
];

const pct = (hour: number) => `${(hour / 24) * 100}%`;

export default function Schedules() {
	return (
		<section id="schedules" className="section section-stage" aria-labelledby="schedules-title">
			<ThreeStage effect="bell" className="stage-soft" speed={0.7} hue={32} saturation={0.6} brightness={0.8} opacity={0.7} />
			<div className="container">
				<SectionHeader
					index="05"
					eyebrow="Schedules"
					title={<span id="schedules-title">A crew that clocks in on its own.</span>}
					lead="Cron expressions, one-shot timers, and heartbeats persist in SQLite and post into rooms. List them with omp-agent schedule and pause any of them across restarts."
				/>

				<Reveal className="timeline" y={30}>
					<div className="timeline-head">
						<span>00:00 UTC</span>
						<span className="timeline-now">
							<span className="live-dot" aria-hidden="true" /> daemon clock
						</span>
						<span>24:00</span>
					</div>
					<div className="timeline-track" aria-hidden="true">
						{HOURS.map((h) => (
							<span key={h} className={`tick ${h % 6 === 0 ? "is-major" : ""}`} style={{ left: pct(h) }} />
						))}
						<div className="timeline-row row-heartbeat">
							{HEARTBEATS.map((h) => (
								<span key={h} className="beat" style={{ left: pct(h), animationDelay: `${(h / 24) * 12}s` }} />
							))}
						</div>
						<div className="timeline-row row-cron">
							<span className="fire fire-cron" style={{ left: pct(9), animationDelay: `${(9 / 24) * 12}s` }}>
								<span>0 9 * * 1-5</span>
							</span>
						</div>
						<div className="timeline-row row-once">
							<span className="fire fire-once" style={{ left: pct(17.5), animationDelay: `${(17.5 / 24) * 12}s` }}>
								<span>one-shot</span>
							</span>
						</div>
						<span className="playhead" />
					</div>
					<div className="timeline-legend">
						<span className="legend-heartbeat">heartbeat · 30m</span>
						<span className="legend-cron">cron</span>
						<span className="legend-once">one-shot</span>
					</div>
				</Reveal>

				<ul className="point-grid is-three">
					{CARDS.map((card, i) => (
						<Reveal as="li" key={card.kind} className={`point point-${card.kind}`} delay={i * 0.08}>
							<code>{card.code}</code>
							<p>{card.body}</p>
						</Reveal>
					))}
				</ul>
				<p className="fine-print">
					Ids are runtime values such as <code>&lt;peer&gt;:schedule:0</code> and <code>&lt;peer&gt;:heartbeat</code>;{" "}
					<code>omp-agent schedule &lt;id&gt; off</code> pauses one.
				</p>
			</div>
		</section>
	);
}
