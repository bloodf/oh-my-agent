import { redirect } from "next/navigation";
import { daemonGet } from "@/lib/daemon";
import type { RoomInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
	let first: RoomInfo | undefined;
	try {
		first = (await daemonGet<{ channels: RoomInfo[] }>("/api/channels"))
			.channels[0];
	} catch {
		first = undefined;
	}
	if (first) redirect(`/rooms/${encodeURIComponent(first.id)}`);
	return (
		<div className="p-6 text-sm text-zinc-400">
			<h1 className="mb-2 text-lg font-semibold text-zinc-100">No rooms yet</h1>
			<p>Start the daemon and its crew; their rooms appear in the rail.</p>
		</div>
	);
}
