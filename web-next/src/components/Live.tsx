"use client";
/**
 * Purpose: Keep a server-rendered page current. One EventSource on this
 * origin relays the daemon's frames; a frame that could change what is on
 * screen refreshes the server tree, debounced so a burst is one refetch.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function Live({ room }: { room?: string }) {
	const router = useRouter();
	useEffect(() => {
		const source = new EventSource("/api/live");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = () => {
			clearTimeout(timer);
			timer = setTimeout(() => router.refresh(), 150);
		};
		source.addEventListener("frame", (event) => {
			let frame: { type?: string; room?: string; message?: { room?: string } };
			try {
				frame = JSON.parse((event as MessageEvent).data);
			} catch {
				return;
			}
			const frameRoom = frame.room ?? frame.message?.room;
			if (frame.type === "message" || frame.type === "reaction") {
				if (room === undefined || frameRoom === room) refresh();
				return;
			}
			refresh();
		});
		return () => {
			clearTimeout(timer);
			source.close();
		};
	}, [router, room]);
	return null;
}
