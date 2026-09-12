import { Action } from "@/components/Action";
import { Live } from "@/components/Live";
import { daemonGet } from "@/lib/daemon";
import type { Artifact } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ArtifactsPage() {
	const { artifacts } = await daemonGet<{ artifacts: Artifact[] }>(
		"/api/artifacts",
	);
	return (
		<>
			<Live />
			<header className="border-b border-zinc-800 px-4 py-2">
				<h1 className="text-sm font-semibold">Artifacts</h1>
			</header>
			<section
				id="artifacts"
				className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
			>
				<p className="text-xs text-zinc-500">
					HTML the agents opened in Lavish Editor for your review.
				</p>
				{artifacts.length === 0 && (
					<p className="text-sm text-zinc-500">No artifacts yet.</p>
				)}
				{artifacts.map((artifact) => (
					<div
						key={artifact.file}
						className="artifact flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2"
						data-file={artifact.file}
					>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium">
								{artifact.file.split("/").pop()}
							</div>
							<div className="truncate text-xs text-zinc-500">
								{artifact.file}
							</div>
							<div className="text-[11px] text-zinc-500">
								{artifact.status}
								{artifact.pendingPrompts > 0
									? ` · ${artifact.pendingPrompts} queued`
									: ""}
							</div>
						</div>
						<Action
							path="/api/artifacts"
							body={{ file: artifact.file }}
							label="Open review"
							openUrlFrom={(p) =>
								(p.artifact as { url?: string } | undefined)?.url
							}
						/>
					</div>
				))}
			</section>
		</>
	);
}
