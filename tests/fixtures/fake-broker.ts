/**
 * Purpose: In-process fake auth-broker for harness tests; HTTP server with snapshot + SSE endpoints.
 * Public API: FakeBroker(token?: string) { token, snapshot, url, start(), close(): Promise<void> }
 * Upstream deps: bun, @oh-my-pi/pi-ai/auth-broker (SnapshotResponse, SnapshotStreamSnapshotEvent, AUTH_BROKER_CAPABILITIES_HEADER)
 * Downstream consumers: harness.test.ts
 * Failure modes: start() throws if already started; close idempotent (no-op if not started).
 * Performance: Ephemeral port; no I/O beyond in-memory snapshot.
 */
import {
  AUTH_BROKER_CAPABILITIES_HEADER,
  type SnapshotResponse,
  type SnapshotStreamSnapshotEvent,
} from "@oh-my-pi/pi-ai/auth-broker";

export class FakeBroker {
  public readonly token: string;
  public snapshot: SnapshotResponse;
  #url = "";
  #server: ReturnType<typeof Bun.serve> | undefined;
  #started = false;

  constructor(token?: string) {
    this.token = token ?? "test-token";
    this.snapshot = {
      generation: 1,
      generatedAt: 0,
      serverNowMs: 0,
      credentials: [],
      refresher: {
        enabled: false,
        intervalMs: 0,
        skewMs: 0,
        nextSweepInMs: Number.MAX_SAFE_INTEGER,
      },
    };
  }

  get url(): string {
    return this.#url;
  }

  start(): void {
    if (this.#started) throw new Error("FakeBroker already started");
    const self = this;
    this.#server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/v1/snapshot") {
          const auth = req.headers.get("Authorization") ?? "";
          if (auth !== `Bearer ${self.token}`) {
            return new Response("Unauthorized", { status: 401 });
          }
          return new Response(JSON.stringify(self.snapshot), {
            headers: {
              "Content-Type": "application/json",
              "ETag": `"${self.snapshot.generation}"`,
              "Cache-Control": "no-store",
              "Vary": AUTH_BROKER_CAPABILITIES_HEADER,
            },
          });
        }

        if (url.pathname === "/v1/snapshot/stream") {
          const auth = req.headers.get("Authorization") ?? "";
          if (auth !== `Bearer ${self.token}`) {
            return new Response("Unauthorized", { status: 401 });
          }
          const event: SnapshotStreamSnapshotEvent = {
            kind: "snapshot",
            ...self.snapshot,
          };
          const body = JSON.stringify(event);
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`event: snapshot\ndata: ${body}\n\n`),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });
    this.#started = true;
    this.#url = `http://${this.#server.hostname}:${this.#server.port}`;
  }

  async close(): Promise<void> {
    this.#server?.stop(true);
    this.#server = undefined;
    this.#started = false;
    this.#url = "";
  }
}
