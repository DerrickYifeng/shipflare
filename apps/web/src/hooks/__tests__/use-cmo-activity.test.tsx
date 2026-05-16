// Tests for useCmoActivity (Task 11 of spec
// 2026-05-15-agent-activity-feed.md).
//
// Lives under src/**/__tests__ so vitest picks it up via the "dom" project
// in apps/web/vitest.config.ts (happy-dom environment). The "node" project
// only globs test/**/*.test.ts and would refuse to mount a React tree.
//
// We mock three boundaries:
//
//   1. agents/react -- useAgent. Avoids a real WebSocket and exposes a
//      captured onMessage handler so we can synthesize live frames. The
//      mock also stubs out stub.getRecentActivity for seed-replay.
//
//   2. @/auth-client -- the Better Auth client. Replaced with a fake
//      authClient.useSession() that returns a logged-in user.
//
//   3. globalThis.fetch -- only the /api/cmo-ws-token call. Returns a
//      static { token, wsUrl } (the actual route returns both; the hook
//      only reads token).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// --- Mocks ----------------------------------------------------------------

// `vi.mock` factory bodies are hoisted above top-level code, so we can't
// reference module-scope consts inside them directly. `vi.hoisted` lets
// us share mutable state between the factory and the tests.
const testHandles = vi.hoisted(() => ({
  captured: null as ((msg: MessageEvent<string>) => void) | null,
  getRecentActivity: vi.fn(),
}));

function pushMessage(data: string): void {
  if (!testHandles.captured) {
    throw new Error("onMessage handler not registered yet");
  }
  // happy-dom provides MessageEvent constructor; the hook only reads
  // `.data` so any plain object with that field would also work, but
  // we use the real DOM event to mirror runtime behaviour.
  testHandles.captured(new MessageEvent("message", { data }));
}

vi.mock("agents/react", () => ({
  useAgent: (opts: { onMessage?: (msg: MessageEvent<string>) => void }) => {
    testHandles.captured = opts.onMessage ?? null;
    return {
      stub: {
        getRecentActivity: testHandles.getRecentActivity,
      },
    };
  },
}));

vi.mock("@/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "user-1" } },
      isPending: false,
      error: null,
    }),
  },
}));

// `fetch` is global on happy-dom but we want a deterministic stub.
beforeEach(() => {
  testHandles.getRecentActivity.mockReset();
  testHandles.getRecentActivity.mockResolvedValue([
    {
      id: "seed-1",
      createdAt: 1,
      conversationId: "c1",
      parentTurnId: null,
      runId: null,
      sourceAgent: "cmo",
      parentEventId: null,
      kind: "turn_start",
      payload: { kind: "turn_start" },
    },
  ]);

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "fake-token",
          wsUrl: "ws://localhost:3001/agents/cmo/user-1",
        }),
      ),
    ),
  );
});

// Import AFTER the mocks so the hook's module graph picks them up.
import { useCmoActivity } from "../use-cmo-activity";

// --- Tests ----------------------------------------------------------------

describe("useCmoActivity", () => {
  it("seeds events from getRecentActivity once the token is fetched", async () => {
    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );

    await waitFor(() => {
      expect(result.current.events.length).toBeGreaterThan(0);
    });
    expect(result.current.events[0]?.id).toBe("seed-1");
    expect(result.current.isConnected).toBe(true);
    expect(result.current.connectionError).toBeNull();
  });

  it("dedupes events by id when a live frame repeats a seed id", async () => {
    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      pushMessage(
        JSON.stringify({
          id: "seed-1",
          createdAt: 2,
          conversationId: "c1",
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        }),
      );
    });

    expect(result.current.events).toHaveLength(1);
  });

  it("appends a live broadcast whose id is new", async () => {
    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      pushMessage(
        JSON.stringify({
          id: "live-2",
          createdAt: 10,
          conversationId: "c1",
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        }),
      );
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[1]?.id).toBe("live-2");
  });

  it("filters out live frames whose conversationId doesn't match", async () => {
    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      pushMessage(
        JSON.stringify({
          id: "other-conv",
          createdAt: 5,
          conversationId: "c2",
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        }),
      );
    });

    expect(result.current.events).toHaveLength(1);
  });

  it("silently swallows seed-replay failure (live frames still flow)", async () => {
    testHandles.getRecentActivity.mockRejectedValueOnce(new Error("nope"));
    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );

    // Wait until the token has been fetched (isConnected reflects that).
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.events).toHaveLength(0);

    act(() => {
      pushMessage(
        JSON.stringify({
          id: "live-only",
          createdAt: 1,
          conversationId: "c1",
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        }),
      );
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.id).toBe("live-only");
  });

  // ---- Bounded-cache regression tests (H3) -------------------------------
  //
  // These tests intentionally run last in the file. They stream large
  // batches of synthetic frames and override `getRecentActivity` so
  // seed-replay never floods the events array. Placing them earlier
  // in the file caused intermittent leakage of mock state into the
  // subsequent test because the hook re-runs the seed-replay effect
  // when `agent` identity changes -- which it does on every render
  // under our mocked `useAgent`. Keeping these at the end isolates the
  // noise without weakening other tests.

  it("caps events array at MAX_EVENTS (1000) under sweep-heavy load", async () => {
    // Override the default seed (one event) with an empty array AND a
    // permanent (`mockResolvedValue`) override so any re-runs of the
    // seed-replay effect also see an empty seed -- not the default
    // [seed-1] from beforeEach.
    testHandles.getRecentActivity.mockReset();
    testHandles.getRecentActivity.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      for (let i = 0; i < 1500; i += 1) {
        pushMessage(
          JSON.stringify({
            id: `live-${i}`,
            createdAt: i,
            conversationId: "c1",
            parentTurnId: null,
            runId: null,
            sourceAgent: "cmo",
            parentEventId: null,
            kind: "turn_start",
            payload: { kind: "turn_start" },
          }),
        );
      }
    });

    // Events array is capped at 1000; the oldest 500 were dropped, the
    // most recent 1000 (ids 500..1499) are retained in insertion order.
    expect(result.current.events).toHaveLength(1000);
    expect(result.current.events[0]?.id).toBe("live-500");
    expect(result.current.events[result.current.events.length - 1]?.id).toBe(
      "live-1499",
    );
  });

  it("caps seenIds Set at MAX_SEEN_IDS (5000) with insertion-order eviction", async () => {
    testHandles.getRecentActivity.mockReset();
    testHandles.getRecentActivity.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useCmoActivity({ conversationId: "c1" }),
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // Stream 5500 unique ids -- 500 over the cap. The dedupe ledger
    // should evict the 500 oldest ids; replaying id "live-0" should
    // therefore be treated as new again, while "live-5499" (most
    // recent) is still recognised as a dupe.
    act(() => {
      for (let i = 0; i < 5500; i += 1) {
        pushMessage(
          JSON.stringify({
            id: `live-${i}`,
            createdAt: i,
            conversationId: "c1",
            parentTurnId: null,
            runId: null,
            sourceAgent: "cmo",
            parentEventId: null,
            kind: "turn_start",
            payload: { kind: "turn_start" },
          }),
        );
      }
    });

    // The events array is capped at 1000 (separate cap, see test above).
    expect(result.current.events).toHaveLength(1000);
    expect(
      result.current.events[result.current.events.length - 1]?.id,
    ).toBe("live-5499");

    // Re-push the very oldest id. If seenIds correctly evicted it, the
    // hook treats it as fresh and appends. If the cap is missing, the
    // hook would skip it as a dupe and the tail wouldn't change.
    act(() => {
      pushMessage(
        JSON.stringify({
          id: "live-0",
          createdAt: 99_999,
          conversationId: "c1",
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        }),
      );
    });
    expect(
      result.current.events[result.current.events.length - 1]?.id,
    ).toBe("live-0");

    // Re-push a recent id -- still inside the ledger, must dedupe.
    const lengthBefore = result.current.events.length;
    act(() => {
      pushMessage(
        JSON.stringify({
          id: "live-5499",
          createdAt: 99_999,
          conversationId: "c1",
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        }),
      );
    });
    expect(result.current.events).toHaveLength(lengthBefore);
  });
});
