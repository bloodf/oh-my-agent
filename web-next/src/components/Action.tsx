"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** A button that calls one proxied route and refreshes the server tree. */
export function Action({
	path,
	method = "POST",
	body,
	label,
	className = "",
	openUrlFrom,
}: {
	path: string;
	method?: string;
	body?: unknown;
	label: string;
	className?: string;
	/** Read a URL from the response and open it in a new tab. */
	openUrlFrom?: (payload: Record<string, unknown>) => string | undefined;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<span className="inline-flex flex-col">
			<button
				type="button"
				className={`rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50 ${className}`}
				disabled={busy}
				onClick={() => {
					setBusy(true);
					setError("");
					void fetch(path, {
						method,
						headers:
							body === undefined ? {} : { "content-type": "application/json" },
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					})
						.then(async (response) => {
							const payload = (await response.json()) as Record<
								string,
								unknown
							> & { error?: { message?: string } };
							if (!response.ok)
								throw new Error(
									payload.error?.message ?? `HTTP ${response.status}`,
								);
							const url = openUrlFrom?.(payload);
							if (url) window.open(url, "_blank", "noopener");
							router.refresh();
						})
						.catch((cause) =>
							setError(cause instanceof Error ? cause.message : String(cause)),
						)
						.finally(() => setBusy(false));
				}}
			>
				{label}
			</button>
			{error && (
				<span role="alert" className="text-[11px] text-red-400">
					{error}
				</span>
			)}
		</span>
	);
}
