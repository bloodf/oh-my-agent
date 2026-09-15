import { ArrowUpRight, Laptop, Lock, Server } from "lucide-react";
import ThreeStage from "../threeui/ThreeStage";
import { CountUp, Reveal, SectionHeader } from "../ui/primitives";
import { AUDIT_CONNECTION_CAP, DOCS, TICKET_TTL_SECONDS } from "../data";

// docs/remote-exposure.md: the daemon never binds a routable address; a proxy
// terminates TLS and forwards only to the loopback console listener.
const HOPS = [
	{ icon: Laptop, name: "Your browser", detail: "operator token in request headers" },
	{ icon: Lock, name: "TLS proxy", detail: "terminates HTTPS, injects the proxy secret" },
	{ icon: Server, name: "127.0.0.1 console", detail: "OMA_REMOTE=1 · trust model: remote" },
];

const GUARDS = [
	"In remote mode with the console enabled, OMA_CONSOLE_ORIGIN is required; the daemon refuses to boot without it.",
	"A routable OMA_CONSOLE_HOST, OMA_CONTROL_HOST, or gateway host is refused in every mode.",
	"console-token and console-proxy-secret must be mode 0600 or boot stops.",
	"One-time, path-bound tickets authenticate the shell, assets, and WebSocket upgrade.",
];

export default function Remote() {
	return (
		<section id="remote" className="section section-stage" aria-labelledby="remote-title">
			<ThreeStage effect="warp" className="stage-soft" variant="streaks" speed={4} hue={-40} saturation={0.7} brightness={0.7} />
			<div className="container">
				<SectionHeader
					index="09"
					eyebrow="Remote exposure"
					title={<span id="remote-title">Loopback by default. Remote only behind TLS and a token.</span>}
					lead="Going beyond loopback is a reverse proxy in front plus an explicit remote mode. One operator per daemon: the operator token is not a per-user credential, and this is not a multi-tenant service."
				/>

				<Reveal className="hops" y={24}>
					{HOPS.map((hop, i) => {
						const Icon = hop.icon;
						return (
							<div key={hop.name} className="hop-wrap">
								<div className="hop">
									<Icon size={22} aria-hidden="true" />
									<strong>{hop.name}</strong>
									<span>{hop.detail}</span>
								</div>
								{i < HOPS.length - 1 ? <span className="hop-wire" aria-hidden="true" /> : null}
							</div>
						);
					})}
				</Reveal>

				<div className="remote-grid">
					<ul className="guard-list">
						{GUARDS.map((guard, i) => (
							<Reveal as="li" key={guard} delay={i * 0.06}>
								{guard}
							</Reveal>
						))}
					</ul>
					<div className="stat-row is-stack">
						<Reveal className="stat">
							<span className="stat-value">
								<CountUp to={TICKET_TTL_SECONDS} />s
							</span>
							<span className="stat-label">ticket lifetime, consumed on first presentation</span>
						</Reveal>
						<Reveal className="stat" delay={0.08}>
							<CountUp to={AUDIT_CONNECTION_CAP} className="stat-value" />
							<span className="stat-label">live authenticated connections audited; the 33rd is refused</span>
						</Reveal>
					</div>
				</div>

				<p className="fine-print">
					The Caddy, SSH-tunnel, and <code>tailscale serve</code> recipes each passed 11 of 11 checks against a real proxy; public
					ACME issuance for the Caddy recipe is still unverified.{" "}
					<a className="text-link" href={DOCS.remote} target="_blank" rel="noreferrer">
						Read the remote exposure runbook <ArrowUpRight size={14} aria-hidden="true" />
					</a>
				</p>
			</div>
		</section>
	);
}
