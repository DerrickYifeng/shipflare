// Spike #10 — Resumable SSE streaming.
//
// Goal: prove that a disconnected client can resume mid-stream using the
// standard `Last-Event-ID` request header (the same one EventSource sends
// automatically on reconnect). This is what Phase 1's founder UI chat will
// use to recover if the WebSocket / fetch-stream drops mid-response.
//
// Wire format is SSE-compliant:
//
//   id: <n>
//   data: chunk-<n>
//   \n
//
// Resume semantics: a request with `last-event-id: 4` starts emitting at
// id=5 (not 4) — id=4 was the *last delivered* event, so the client is
// asking for everything after it.

import type { Env } from "../index";

export default async function handler(req: Request, _env: Env): Promise<Response> {
  const lastEventId = req.headers.get("last-event-id");

  // Input validation: parseInt("invalid") → NaN, NaN + 1 → NaN, and `i < NaN`
  // is always false, so a malformed header would silently emit zero chunks.
  // Treat any non-numeric header as "start from the beginning". For Phase 1,
  // this same guard belongs in the founder-UI stream handler — a client
  // shouldn't be able to break the stream by sending garbage in the header.
  const parsed = lastEventId ? parseInt(lastEventId, 10) + 1 : 0;
  const startFrom = Number.isNaN(parsed) ? 0 : parsed;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (let i = startFrom; i < startFrom + 10; i++) {
        controller.enqueue(encoder.encode(`id: ${i}\ndata: chunk-${i}\n\n`));
        // Small delay so the stream is actually chunked over the wire,
        // not coalesced into a single write. Mirrors the cadence the
        // Phase 1 chat stream will exhibit when LLM tokens arrive.
        await new Promise((r) => setTimeout(r, 20));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      // Hint to any intermediate CDN: don't buffer. Cloudflare's edge
      // respects this for SSE streams (same as Spike #3's MCP transport).
      "x-accel-buffering": "no",
    },
  });
}
