import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { signJwt } from "../src/lib/jwt";
import { transportName } from "../src/lib/do-name";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for CMO `onConnect` — Task 6 (spec 2026-05-15-agent-activity-feed).
 *
 * The browser opens a WebSocket to `/agents/cmo/<userId>?token=<jwt>` for the
 * activity feed. CMO.onConnect verifies the token before letting the WS
 * live; bad tokens get closed with WebSocket code 1008 (Policy Violation).
 *
 * Three cases:
 *  - valid activity-scoped token → WS stays open (no immediate close)
 *  - missing token              → close 1008
 *  - wrong scope                → close 1008
 *
 * Schema bootstrap pattern: tests below drive `stub.fetch()` directly with
 * a WS upgrade. partyserver's `Server.fetch` triggers `onStart` on first
 * call, which in turn requires the schema. The pattern follows
 * `cmo-routing.test.ts` — apply the schema via `runInDurableObject` to the
 * stub we'll later WS-upgrade against, so the cold start succeeds.
 */

async function bootstrapCmoFor(userId: string): Promise<void> {
  const stub = env.CMO.get(env.CMO.idFromName(transportName(userId)));
  await runInDurableObject(stub, async (_instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

/**
 * Open a WS to the per-user CMO DO with an optional `?token=` query string.
 * Bypasses the Worker route and calls the DO stub directly — equivalent to
 * what `handleCmoWsRequest` does in production, minus the routing.
 */
async function openWs(
  userId: string,
  token: string | null,
): Promise<Response> {
  const stub = env.CMO.get(env.CMO.idFromName(transportName(userId)));
  const url = token
    ? `https://internal/agents/cmo/${userId}?token=${encodeURIComponent(token)}`
    : `https://internal/agents/cmo/${userId}`;
  return stub.fetch(url, { headers: { upgrade: "websocket" } });
}

/**
 * Wait for a WS close event or time out. Returns the close code so tests can
 * assert 1008 (Policy Violation) on auth failures.
 */
function waitForClose(
  ws: WebSocket,
  timeoutMs: number,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`WS did not close within ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.addEventListener("close", (ev: CloseEvent) => {
      clearTimeout(timer);
      resolve({ code: ev.code, reason: ev.reason });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WS errored"));
    });
  });
}

describe("CMO onConnect — activity-scope WebSocket auth", () => {
  it("accepts a valid activity-scoped token (no immediate close)", async () => {
    const uid = "ws-auth-user-A";
    await bootstrapCmoFor(uid);
    const token = await signJwt(
      { userId: uid, scope: "activity" },
      env.MCP_JWT_SECRET,
      60,
    );

    const res = await openWs(uid, token);
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket!.accept();
    // Stay open: race a close event against a 300ms keepalive timeout.
    // If the auth check rejects, the close event resolves with a 1008 code.
    // If the auth check accepts, the keepalive wins. We want the keepalive.
    let closedWith: { code: number; reason: string } | null = null;
    const closeP = new Promise<void>((resolve) => {
      res.webSocket!.addEventListener("close", (ev: CloseEvent) => {
        closedWith = { code: ev.code, reason: ev.reason };
        resolve();
      });
    });
    const aliveP = new Promise<void>((r) => setTimeout(r, 300));
    await Promise.race([closeP, aliveP]);
    expect(closedWith).toBeNull();
    res.webSocket!.close();
  });

  it("closes the WS with 1008 when no token is provided", async () => {
    const uid = "ws-auth-user-B";
    await bootstrapCmoFor(uid);
    const res = await openWs(uid, null);
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    const { code } = await waitForClose(res.webSocket!, 2000);
    expect(code).toBe(1008);
  });

  it("closes the WS with 1008 when token scope is not 'activity'", async () => {
    const uid = "ws-auth-user-C";
    await bootstrapCmoFor(uid);
    const token = await signJwt(
      { userId: uid, scope: "mcp" },
      env.MCP_JWT_SECRET,
      60,
    );
    const res = await openWs(uid, token);
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    const { code } = await waitForClose(res.webSocket!, 2000);
    expect(code).toBe(1008);
  });
});
