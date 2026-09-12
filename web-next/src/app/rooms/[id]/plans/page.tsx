import Link from "next/link";
import { Live } from "@/components/Live";
import { Markdown } from "@/components/Markdown";
import { daemonGet } from "@/lib/daemon";
import type { Plan } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PlansPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const room = decodeURIComponent(id);
	const { plans } = await daemonGet<{ plans: Plan[] }>(
		`/api/channels/${encodeURIComponent(room)}/plans`,
	);
	return (
		<>
			<Live room={room} />
			<header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
				<h1 className="text-sm font-semibold">{room}</h1>
				<nav className="flex gap-3 text-xs text-zinc-400">
					<Link
						href={`/rooms/${encodeURIComponent(room)}`}
						className="hover:text-zinc-100"
					>
						Conversation
					</Link>
					<span className="text-zinc-100">Plans</span>
				</nav>
			</header>
			<section
				id="plans"
				className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
			>
				{plans.length === 0 && (
					<p className="text-sm text-zinc-500">No plans in this room.</p>
				)}
				{plans.map((plan) => (
					<article
						key={plan.id}
						className="plan rounded-lg border border-zinc-800 p-4"
						data-id={plan.id}
					>
						<div className="mb-2 flex items-baseline justify-between">
							<h2 className="text-sm font-semibold">{plan.title}</h2>
							<span className="rounded-full border border-zinc-800 px-2 text-[11px] text-zinc-400">
								{plan.status} · rev {plan.revision} · {plan.updatedBy}
							</span>
						</div>
						<Markdown body={plan.body} />
					</article>
				))}
			</section>
		</>
	);
}
