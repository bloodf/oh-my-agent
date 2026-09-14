import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "../ui/primitives";


export default function DemoTeaser() {
	return (
		<section id="demo" className="section" aria-labelledby="demo-title">
			<div className="container demo">
				<Reveal className="demo-copy">
					<p className="eyebrow">
						<span className="eyebrow-index">12</span>Live demo
					</p>
					<h2 id="demo-title" className="section-title">
						Poke the real console. No install.
					</h2>
					<p className="section-lead">
						The demo mounts the real console UI from this repository against mock data, so you can click through rooms,
						agents, and schedules without running a daemon.
					</p>
					<Link href="/console" className="btn btn-primary btn-large">
						Open the console demo <ArrowRight size={18} aria-hidden="true" />
					</Link>
				</Reveal>
				<Reveal className="demo-shot" y={40} delay={0.1}>
					<Link href="/console" className="demo-frame" aria-label="Open the console demo">
						<Image
							src="/home/console.png"
							alt="The oh-my-agent console with channels, direct messages, thread links, and the message composer"
							width={1440}
							height={1000}
							sizes="(max-width: 900px) 100vw, 55vw"
						/>
						<span className="demo-glint" aria-hidden="true" />
					</Link>
				</Reveal>
			</div>
		</section>
	);
}
