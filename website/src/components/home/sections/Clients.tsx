import { Globe, SquareTerminal, TerminalSquare } from "lucide-react";
import ThreeStage from "../threeui/ThreeStage";
import { CountUp, Reveal, SectionHeader } from "../ui/primitives";
import { CLI_VERBS, CONSOLE_THEMES } from "../data";

// README.md "How it works" and docs/guide/concepts.md "Surfaces".
const CLIENTS = [
	{ icon: TerminalSquare, name: "OMP TUI", wire: "JSON-RPC · unix socket", body: "Starts the daemon on session start. A widget shows running and parked counts; /manage opens the manager." },
	{ icon: SquareTerminal, name: "omp-agent CLI", wire: "JSON-RPC · unix socket", body: "Same socket, works with no TUI. --json prints the protocol result for scripts." },
	{ icon: Globe, name: "Browser console", wire: "Loopback HTTP + WebSocket", body: "Token-gated. Rooms, agents with schedules, artifacts, and profiles in one workspace." },
];

export default function Clients() {
	const verbs = [...CLI_VERBS, ...CLI_VERBS];
	return (
		<section id="clients" className="section section-stage" aria-labelledby="clients-title">
			<ThreeStage effect="stream" className="stage-soft" speed={0.5} hue={-65} saturation={0.75} brightness={0.75} opacity={0.6} />
			<div className="container">
				<SectionHeader
					index="08"
					eyebrow="Three clients, one daemon"
					title={<span id="clients-title">Watch from wherever you are. It is the same daemon.</span>}
					lead="The TUI, the CLI, and the browser are all clients. The daemon owns workers, rooms, schedules, and SQLite, and binds loopback only, in every mode."
					align="center"
				/>

				<div className="converge">
					<ul className="client-grid">
						{CLIENTS.map((client, i) => {
							const Icon = client.icon;
							return (
								<Reveal as="li" key={client.name} className="client" delay={i * 0.1}>
									<Icon size={22} aria-hidden="true" />
									<h3>{client.name}</h3>
									<p className="client-wire">{client.wire}</p>
									<p>{client.body}</p>
								</Reveal>
							);
						})}
					</ul>
					<svg className="converge-lines" viewBox="0 0 600 90" preserveAspectRatio="none" aria-hidden="true">
						<path d="M100 0 C100 50, 300 40, 300 90" />
						<path d="M300 0 L300 90" />
						<path d="M500 0 C500 50, 300 40, 300 90" />
					</svg>
					<Reveal className="daemon-core" y={16}>
						<span className="core-pulse" aria-hidden="true" />
						<strong>oh-my-agent daemon</strong>
						<span>127.0.0.1 · workers · rooms · schedules · SQLite</span>
					</Reveal>
				</div>

				<div className="stat-row is-compact">
					<Reveal className="stat">
						<CountUp to={CLI_VERBS.length} className="stat-value" />
						<span className="stat-label">verbs in the omp-agent shell CLI</span>
					</Reveal>
					<Reveal className="stat" delay={0.08}>
						<CountUp to={CONSOLE_THEMES} className="stat-value" />
						<span className="stat-label">console workspace themes, light and dark</span>
					</Reveal>
				</div>

				<div className="marquee" role="img" aria-label={`CLI verbs: ${CLI_VERBS.join(", ")}`}>
					<ul className="marquee-track" aria-hidden="true">
						{verbs.map((verb, i) => (
							<li key={`${verb}-${i}`}>
								<code>omp-agent {verb}</code>
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
}
