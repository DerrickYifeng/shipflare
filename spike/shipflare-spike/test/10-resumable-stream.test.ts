// Spike #10 — Resumable SSE streaming tests.
//
// Verifies:
//   (a) full stream emits ids 0..9 with `chunk-N` bodies, content-type
//       is exactly text/event-stream
//   (b) `Last-Event-ID: 4` request resumes at id=5 (not 4) and emits 5..14
//   (c) malformed `Last-Event-ID` (`not-a-number`) falls back to id=0 —
//       input validation in place so the stream never silently emits zero
//       chunks (a real Phase 1 hardening concern)

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

interface SseChunk {
  id: number;
  data: string;
}

async function consumeStream(res: Response): Promise<SseChunk[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: SseChunk[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    // Parse complete SSE frames (separated by blank line `\n\n`).
    let sepIdx = buffer.indexOf("\n\n");
    while (sepIdx >= 0) {
      const frame = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const idMatch = frame.match(/^id:\s*(\d+)/m);
      const dataMatch = frame.match(/^data:\s*(.*)$/m);
      if (idMatch && dataMatch) {
        chunks.push({ id: parseInt(idMatch[1]!, 10), data: dataMatch[1]! });
      }
      sepIdx = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  return chunks;
}

describe("Spike #10: Resumable streaming", () => {
  it("first connection delivers chunks 0..9", async () => {
    const res = await SELF.fetch("https://example.com/spike/10");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const chunks = await consumeStream(res);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]!.id).toBe(0);
    expect(chunks[0]!.data).toBe("chunk-0");
    expect(chunks[9]!.id).toBe(9);
    expect(chunks[9]!.data).toBe("chunk-9");
  }, 30_000);

  it("resumes from Last-Event-ID: 4 → emits 5..14", async () => {
    const res = await SELF.fetch("https://example.com/spike/10", {
      headers: { "last-event-id": "4" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const chunks = await consumeStream(res);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]!.id).toBe(5);
    expect(chunks[0]!.data).toBe("chunk-5");
    expect(chunks[9]!.id).toBe(14);
    expect(chunks[9]!.data).toBe("chunk-14");
  }, 30_000);

  it("invalid Last-Event-ID gracefully falls back to id=0", async () => {
    // The handler has a NaN guard so a malformed header doesn't silently
    // emit zero chunks. This validates the input-validation finding from
    // Phase 0 — Phase 1 founder UI gets the same protection for free.
    const res = await SELF.fetch("https://example.com/spike/10", {
      headers: { "last-event-id": "not-a-number" },
    });
    expect(res.status).toBe(200);
    const chunks = await consumeStream(res);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]!.id).toBe(0);
    expect(chunks[0]!.data).toBe("chunk-0");
    expect(chunks[9]!.id).toBe(9);
    expect(chunks[9]!.data).toBe("chunk-9");
  }, 30_000);
});
