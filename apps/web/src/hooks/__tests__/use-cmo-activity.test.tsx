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
});
