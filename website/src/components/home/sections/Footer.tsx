import Link from "next/link";
import { BrandMark, GitHubMark } from "../ui/primitives";
import { DOCS, GITHUB_URL, NPM_URL, VERSION } from "../data";

const COLUMNS = [
	{
		title: "Project",
		links: [
			{ label: "GitHub", href: GITHUB_URL },
			{ label: "npm · @bloodf/oh-my-agent", href: NPM_URL },
			{ label: "Changelog", href: DOCS.changelog },
			{ label: "Console demo", href: "/console", internal: true },
		],
	},
	{
		title: "Docs",
		links: [
			{ label: "Getting started", href: DOCS.gettingStarted },
			{ label: "CLI", href: DOCS.cli },
			{ label: "Web console", href: DOCS.console },
			{ label: "Architecture", href: DOCS.architecture },
		],
	},
	{
		title: "Security",
		links: [
			{ label: "Remote exposure", href: DOCS.remote },
			{ label: "SECURITY.md", href: DOCS.security },
			{ label: "All docs", href: DOCS.docs },
		],
	},
];

export default function Footer() {
	return (
		<footer className="footer">
			<div className="container footer-grid">
				<div className="footer-brand">
					<a href="#top" className="nav-brand" aria-label="oh-my-agent, back to top">
						<BrandMark size={32} />
						<span>oh-my-agent</span>
					</a>
					<p>
						An oh-my-pi plugin. Local daemon, persistent rooms, no cloud. MIT licensed. v{VERSION}.
					</p>
					<a className="nav-icon" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="oh-my-agent on GitHub">
						<GitHubMark size={18} />
					</a>
				</div>
				{COLUMNS.map((col) => (
					<nav key={col.title} className="footer-col" aria-label={col.title}>
						<h2>{col.title}</h2>
						<ul>
							{col.links.map((link) => (
								<li key={link.label}>
									{"internal" in link && link.internal ? (
										<Link href={link.href}>{link.label}</Link>
									) : (
										<a href={link.href} target="_blank" rel="noreferrer">
											{link.label}
										</a>
									)}
								</li>
							))}
						</ul>
					</nav>
				))}
			</div>
		</footer>
	);
}
