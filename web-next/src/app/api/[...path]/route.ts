/**
 * Purpose: The browser's only door to the daemon. Every `/api/*` the client
 * needs is forwarded with the operator token added server-side, so the
 * token never reaches the browser and the page stays same-origin.
 */
import { type NextRequest, NextResponse } from "next/server";
import { daemonFetch } from "@/lib/daemon";

export const dynamic = "force-dynamic";

async function forward(
	request: NextRequest,
	context: { params: Promise<{ path: string[] }> },
) {
	const { path } = await context.params;
	const target = `/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
	let body: unknown;
	if (request.method !== "GET" && request.method !== "HEAD") {
		const text = await request.text();
		if (text.length > 0) {
			try {
				body = JSON.parse(text);
			} catch {
				return NextResponse.json(
					{ error: { message: "Body is not valid JSON" } },
					{ status: 400 },
				);
			}
		}
	}
	try {
		const { status, payload } = await daemonFetch(target, {
			method: request.method,
			body,
		});
		return NextResponse.json(payload, { status });
	} catch (error) {
		return NextResponse.json(
			{
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			},
			{ status: 502 },
		);
	}
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
