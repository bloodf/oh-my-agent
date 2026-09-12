/**
 * Purpose: The daemon's event stream, re-emitted to the browser as
 * server-sent events. The Next server holds the authenticated WebSocket;
 * the page holds an EventSource on its own origin and refreshes the
 * server-rendered tree when a frame concerns it.
 */
import { daemon } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	const { origin, token } = await daemon();
	const url = new URL("/api/events", origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("token", token);
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const socket = new WebSocket(url);
			const send = (event: string, data: string) =>
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
				);
			const close = () => {
				try {
					socket.close();
				} catch {
					// Already closed.
				}
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};
			socket.onopen = () => send("open", "{}");
			socket.onmessage = (message) => send("frame", String(message.data));
			socket.onerror = () => close();
			socket.onclose = () => close();
			request.signal.addEventListener("abort", close);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		},
	});
}
