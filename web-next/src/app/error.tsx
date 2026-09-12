"use client";
/** A daemon refusal or an unreachable daemon, shown in place of the page. */
export default function ErrorPage({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<div className="p-6 text-sm">
			<h1 className="mb-2 text-lg font-semibold text-red-300">
				The daemon did not answer this page
			</h1>
			<p className="mb-4 text-zinc-300">{error.message}</p>
			<button
				type="button"
				className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
				onClick={() => reset()}
			>
				Try again
			</button>
		</div>
	);
}
