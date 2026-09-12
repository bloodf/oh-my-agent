"use client";
import { useRouter } from "next/navigation";
import type { MessageReaction } from "@/lib/types";

const EMOJI = ["👀", "⏳", "✅", "❌"];

export function Reactions({
	messageId,
	reactions,
}: {
	messageId: number;
	reactions: MessageReaction[];
}) {
	const router = useRouter();
	const grouped = new Map<string, string[]>();
	for (const r of reactions)
		grouped.set(r.emoji, [...(grouped.get(r.emoji) ?? []), r.actor]);
	const toggle = async (emoji: string) => {
		await fetch(`/api/messages/${messageId}/reactions/toggle`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ emoji }),
		});
		router.refresh();
	};
	return (
		<div className="mt-1 flex flex-wrap gap-1">
			{[...grouped].map(([emoji, actors]) => (
				<button
					key={emoji}
					type="button"
					className="reaction rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-xs"
					title={actors.join(", ")}
					onClick={() => void toggle(emoji)}
				>
					{emoji} {actors.length}
				</button>
			))}
			<span className="group/add relative">
				<button
					type="button"
					className="rounded-full border border-dashed border-zinc-800 px-2 py-0.5 text-xs text-zinc-500"
					aria-label="Add reaction"
				>
					+
				</button>
				<span className="absolute left-0 top-full z-10 hidden gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1 group-focus-within/add:flex group-hover/add:flex">
					{EMOJI.map((emoji) => (
						<button
							key={emoji}
							type="button"
							className="px-1"
							onClick={() => void toggle(emoji)}
						>
							{emoji}
						</button>
					))}
				</span>
			</span>
		</div>
	);
}
