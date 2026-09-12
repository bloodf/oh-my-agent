import type { Metadata } from "next";
import Link from "next/link";
import { daemonGet } from "@/lib/daemon";
import type { RoomInfo } from "@/lib/types";
import "./globals.css";

export const metadata: Metadata = {
	title: "oh-my-agent console",
	description: "Server-rendered console for the oh-my-agent daemon.",
};
export const dynamic = "force-dynamic";

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	let channels: RoomInfo[] = [];
	let problem = "";
	try {
		channels = (await daemonGet<{ channels: RoomInfo[] }>("/api/channels"))
			.channels;
	} catch (error) {
		problem = error instanceof Error ? error.message : String(error);
	}
	return (
		<html lang="en" className="dark h-full">
			<body className="flex h-svh overflow-hidden">
				<nav
					aria-label="Rooms"
					className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/60"
				>
					<div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold">
						oh-my-agent
					</div>
					<ul id="channels" className="min-h-0 flex-1 overflow-y-auto py-1">
						{channels.map((room) => (
							<li key={room.id}>
								<Link
									href={`/rooms/${encodeURIComponent(room.id)}`}
									className="channel block truncate px-3 py-1 text-sm hover:bg-zinc-900"
								>
									{room.id}
								</Link>
							</li>
						))}
						{channels.length === 0 && !problem && (
							<li className="px-3 py-1 text-xs text-zinc-500">No rooms yet.</li>
						)}
					</ul>
					<div className="border-t border-zinc-800 py-1 text-sm">
						<Link href="/agents" className="block px-3 py-1 hover:bg-zinc-900">
							Agents
						</Link>
						<Link
							href="/artifacts"
							className="block px-3 py-1 hover:bg-zinc-900"
						>
							Artifacts
						</Link>
					</div>
				</nav>
				<main className="flex min-w-0 flex-1 flex-col">
					{problem && (
						<p
							role="alert"
							className="border-b border-red-900 bg-red-950/40 px-4 py-2 text-sm text-red-300"
						>
							{problem}
						</p>
					)}
					{children}
				</main>
			</body>
		</html>
	);
}
