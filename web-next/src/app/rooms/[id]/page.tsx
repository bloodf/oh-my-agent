import Link from "next/link";
import { Composer } from "@/components/Composer";
import { Live } from "@/components/Live";
import { Markdown } from "@/components/Markdown";
import { Reactions } from "@/components/Reactions";
import { daemonGet } from "@/lib/daemon";
import { type Profile, personaFor, type RoomMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

function timeLabel(createdAt: number): string {
	return new Intl.DateTimeFormat("en", {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
	}).format(new Date(createdAt));
}

export default async function RoomPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const room = decodeURIComponent(id);
	const [{ messages }, { profile }] = await Promise.all([
		daemonGet<{ messages: RoomMessage[] }>(
			`/api/channels/${encodeURIComponent(room)}/messages?limit=200`,
		),
		daemonGet<{ profile: Profile }>("/api/profile").catch(() => ({
			profile: { operator: {}, agents: {} } as Profile,
		})),
	]);
	return (
		<>
			<Live room={room} />
			<header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
				<h1 className="text-sm font-semibold">{room}</h1>
				<nav className="flex gap-3 text-xs text-zinc-400">
					<span className="text-zinc-100">Conversation</span>
					<Link
						href={`/rooms/${encodeURIComponent(room)}/plans`}
						className="hover:text-zinc-100"
					>
						Plans
					</Link>
				</nav>
			</header>
			<section
				id="messages"
				className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
			>
				{messages.length === 0 && (
					<p className="px-2 text-sm text-zinc-500">No messages yet.</p>
				)}
				{messages.map((message) => {
					const persona = personaFor(profile, message.author);
					return (
						<article
							key={message.id}
							data-id={message.id}
							className="message grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2.5 px-2 py-1.5 hover:bg-zinc-900/60"
						>
							<div className="mt-0.5 flex size-9 items-center justify-center rounded-lg bg-sky-500/10 text-xs font-semibold text-sky-300">
								{persona.avatar}
							</div>
							<div className="min-w-0">
								<div className="mb-0.5 flex items-baseline gap-2">
									<span
										className="author text-sm font-semibold"
										data-author={message.author}
									>
										{persona.name}
									</span>
									<time
										className="text-[11px] text-zinc-500"
										dateTime={new Date(message.createdAt).toISOString()}
									>
										{timeLabel(message.createdAt)}
									</time>
								</div>
								<Markdown body={message.body} />
								<Reactions
									messageId={message.id}
									reactions={message.reactions}
								/>
							</div>
						</article>
					);
				})}
			</section>
			<Composer room={room} />
		</>
	);
}
