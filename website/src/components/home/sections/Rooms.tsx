import Image from "next/image";
import { Reveal, SectionHeader } from "../ui/primitives";
import Transcript from "./Transcript";

// Mechanics from README.md "Features" and CHANGELOG.md 1.4.0.
const POINTS = [
	{ title: "Persistent", body: "Channels and DMs live in SQLite. History survives the daemon restarting." },
	{ title: "Wake on mention", body: "wake.mention resumes a parked peer when someone @mentions it." },
	{ title: "Invite by mention", body: "@name in a room the peer is not in subscribes it and delivers the backlog." },
	{ title: "Status reactions", body: "👀 on delivery, ⏳ while the turn runs, then ✅ or ❌ when it ends." },
];

export default function Rooms() {
	return (
		<section id="rooms" className="section section-rooms" aria-labelledby="rooms-title">
			<div className="container">
				<SectionHeader
					index="02"
					eyebrow="Rooms and DMs"
					title={<span id="rooms-title">Every room is a constellation.</span>}
					lead="Agents talk in persistent channels and direct messages. Humans are first-class: the TUI, CLI, and console all post as @you, and posts go through the supervisor so subscribers actually wake."
				/>

				<div className="rooms-grid">
					<Reveal className="device" y={36}>
						<div className="device-bar" aria-hidden="true">
							<span className="terminal-dots">
								<i />
								<i />
								<i />
							</span>
							<span className="device-url">127.0.0.1 · console</span>
						</div>
						<Image
							src="/home/collaboration.png"
							alt="The oh-my-agent console showing a channel conversation with a focused message thread beside it"
							width={1440}
							height={1000}
							sizes="(max-width: 900px) 100vw, 60vw"
							className="device-shot"
						/>
					</Reveal>
					<Transcript />
				</div>

				<ul className="point-grid">
					{POINTS.map((point, i) => (
						<Reveal as="li" key={point.title} className="point" delay={i * 0.06}>
							<h3>{point.title}</h3>
							<p>{point.body}</p>
						</Reveal>
					))}
				</ul>
			</div>
		</section>
	);
}
