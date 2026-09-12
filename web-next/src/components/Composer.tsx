"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function Composer({ room }: { room: string }) {
	const router = useRouter();
	const [body, setBody] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const send = async () => {
		const text = body.trim();
		if (!text || busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch(
				`/api/channels/${encodeURIComponent(room)}/messages`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ body: text }),
				},
			);
			const payload = (await response.json()) as {
				error?: { message?: string };
			};
			if (!response.ok)
				throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
			setBody("");
			router.refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			id="composer"
			className="border-t border-zinc-800 p-3"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<div className="flex gap-2">
				<textarea
					id="composer-input"
					className="min-h-10 flex-1 resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
					placeholder={`Message ${room} as @you`}
					value={body}
					onChange={(event) => setBody(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void send();
						}
					}}
				/>
				<button
					type="submit"
					className="rounded-md bg-sky-600 px-3 text-sm font-medium disabled:opacity-50"
					disabled={busy}
				>
					Send
				</button>
			</div>
			<p role="alert" className="min-h-4 text-xs text-red-400">
				{error}
			</p>
		</form>
	);
}
