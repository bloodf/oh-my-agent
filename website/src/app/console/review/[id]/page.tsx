import { notFound } from "next/navigation";

/**
 * Stand-in for the Lavish Editor review page an artifact opens. On a real
 * install this is Lavish on its own local port; here it explains that and
 * shows what the agent asked the operator to review.
 */
const ARTIFACTS: Record<string, { title: string; agent: string; summary: string; notes: string[] }> = {
	"release-dashboard": {
		title: "release-0.9-dashboard.html",
		agent: "atlas",
		summary: "Release readiness for Quarry 0.9: scope, blockers, and sign-offs on one page.",
		notes: ["Blocked: directory fsync (forge parked on budget)", "Pending: sentinel sign-off", "2 prompts queued for atlas"],
	},
	"search-results": {
		title: "search-results-v2.html",
		agent: "pixel",
		summary: "Mockup of search results with split-identifier matches highlighted per part.",
		notes: ["Highlight contrast in dark mode", "Keep the path column from wrapping"],
	},
	"merge-budget": {
		title: "merge-io-budget.html",
		agent: "atlas",
		summary: "Proposal to throttle tier-3 merges so they cannot starve queries.",
		notes: ["Closed after the plan moved to #release"],
	},
};

export default async function ArtifactReviewPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const artifact = ARTIFACTS[id];
	if (!artifact) notFound();
	return (
		<main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 bg-background px-4 py-10 text-foreground sm:px-6">
			<p className="rounded-md border border-amber-500/30 bg-amber-100 px-3 py-2 text-xs text-amber-950">
				Demo stand-in. On a real install, <strong>Open review</strong> resumes the session and opens Lavish Editor, where you annotate the page and your
				feedback reaches the agent that is polling.
			</p>
			<header>
				<p className="font-mono text-xs text-muted-foreground">Lavish review · opened by {artifact.agent}</p>
				<h1 className="mt-1 text-2xl font-semibold">{artifact.title}</h1>
				<p className="mt-2 text-sm text-muted-foreground">{artifact.summary}</p>
			</header>
			<section className="rounded-lg border bg-card p-4">
				<h2 className="mb-2 text-sm font-semibold">Annotations</h2>
				<ul className="list-disc space-y-1 pl-5 text-sm">
					{artifact.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			</section>
			<a href="/console?room=%23release" className="text-sm text-primary underline underline-offset-2">
				Back to the console
			</a>
		</main>
	);
}
