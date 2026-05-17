/**
 * `/api/admin/trigger-relay` — test-only admin endpoint (5.1c.18).
 *
 * Used exclusively by `apps/web/e2e/cmo-relay.spec.ts` to deterministically
 * fire the CMO `alarm()` for the authenticated founder during the Playwright
 * real-LLM smoke. In normal operation, `alarm()` fires when the DO's
 * `ctx.storage.setAlarm` deadline lands — this endpoint short-circuits that
 * so the spec doesn't have to mock time.
 *
 * Authorization layers (any failure → 4xx):
 *   1. Session-gated via Better Auth (`getAuth().api.getSession`).
 *   2. Gated to non-production environments: `NODE_ENV !== 'production'`
 *      AND `process.env.ENABLE_ADMIN_TRIGGER_RELAY === '1'`. The second
 *      flag is a belt-and-braces check so even a misconfigured staging
 *      build (e.g. NODE_ENV=development by accident) can't expose the
 *      endpoint without an explicit env opt-in.
 *
 * The endpoint POSTs the founder's own `userId` to core via the existing
 * Service Binding pattern — no new ingress route on apps/core is needed
 * because the pre-existing INTERNAL_ROUTE in `apps/core/src/index.ts`
 * already forwards `/agents/cmo/<userId>/internal/<path>` to the CMO DO.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ENABLE_ADMIN_TRIGGER_RELAY !== "1"
  ) {
    return NextResponse.json(
      { error: "disabled" },
      { status: 403 },
    );
  }

  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const userId = session.user.id;
  const { env } = await getCloudflareContext({ async: true });

  try {
    const coreRes = await env.CORE.fetch(
      `https://internal/agents/cmo/${encodeURIComponent(userId)}/internal/trigger-alarm`,
      {
        method: "POST",
        headers: { "x-shipflare-internal": "1" },
      },
    );
    if (!coreRes.ok) {
      const detail = await coreRes.text();
      return NextResponse.json(
        { error: "core_failed", status: coreRes.status, detail },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "core_threw", detail: message },
      { status: 502 },
    );
  }
}
