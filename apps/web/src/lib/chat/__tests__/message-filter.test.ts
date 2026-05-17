/**
 * 5.1c.17 — verify that the chat message filter hides synthetic system
 * messages but keeps assistant replies and regular system messages.
 */

import { describe, expect, it } from "vitest";
import { shouldRenderMessage } from "../message-filter";

describe("shouldRenderMessage", () => {
  it("hides system messages with metadata.source='daily-relay'", () => {
    expect(
      shouldRenderMessage({
        id: "x",
        role: "system",
        metadata: { source: "daily-relay", firedAt: "2026-05-17T12:00:00Z" },
      }),
    ).toBe(false);
  });

  it("keeps system messages without metadata", () => {
    expect(
      shouldRenderMessage({
        id: "x",
        role: "system",
      }),
    ).toBe(true);
  });

  it("keeps system messages with a non-relay source", () => {
    expect(
      shouldRenderMessage({
        id: "x",
        role: "system",
        metadata: { source: "manual-note" },
      }),
    ).toBe(true);
  });

  it("keeps assistant messages always", () => {
    expect(
      shouldRenderMessage({
        id: "x",
        role: "assistant",
        // even if mislabeled, assistant replies must render
        metadata: { source: "daily-relay" },
      }),
    ).toBe(true);
  });

  it("keeps user messages always", () => {
    expect(
      shouldRenderMessage({
        id: "x",
        role: "user",
      }),
    ).toBe(true);
  });

  it("tolerates non-object metadata defensively", () => {
    expect(
      shouldRenderMessage({
        id: "x",
        role: "system",
        metadata: null,
      }),
    ).toBe(true);
    expect(
      shouldRenderMessage({
        id: "x",
        role: "system",
        metadata: "daily-relay",
      }),
    ).toBe(true);
  });
});
