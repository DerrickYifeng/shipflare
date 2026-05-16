/**
 * `/api/push/subscribe` — POST a Web Push subscription into the CMO DO.
 *
 * Browser flow (see /notifications client):
 *   1. `Notification.requestPermission()` → granted
 *   2. `navigator.serviceWorker.register("/sw.js")`
 *   3. `reg.pushManager.subscribe({ applicationServerKey })` → PushSubscription
 *   4. POST `subscription.toJSON()` to this route
 *
 * We session-gate (Better Auth), then forward via the CORE Service Binding
 * to the founder's CMO DO at `/internal/push-subscribe`. Per spec D13, the
 * web Worker is not a long-running proxy — this is a one-shot write that
 * persists the subscription so a future push trigger inside the CMO DO can
 * reach this browser.
 *
 * The DO route is gated on the `x-shipflare-internal: 1` header (stripped
 * by Cloudflare from edge-originating traffic, so only intra-network
 * Service-Binding callers can set it; the DO re-checks defensively).
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Force dynamic — session lookup needs the live cookie on every call.
export const dynamic = "force-dynamic";

interface PushSubscriptionJson {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export async function POST(req: Request): Promise<Response> {
  const { env } = await getCloudflareContext({ async: true });
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  let raw: PushSubscriptionJson;
  try {
    raw = (await req.json()) as PushSubscriptionJson;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (
    typeof raw.endpoint !== "string" ||
    raw.endpoint.length === 0 ||
    !raw.keys ||
    typeof raw.keys.p256dh !== "string" ||
    typeof raw.keys.auth !== "string"
  ) {
    return new Response("invalid subscription", { status: 400 });
  }

  const res = await env.CORE.fetch(
    `https://internal/agents/cmo/${session.user.id}/internal/push-subscribe`,
    {
      method: "POST",
      headers: {
        "x-shipflare-internal": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: raw.endpoint,
        p256dh: raw.keys.p256dh,
        auth: raw.keys.auth,
      }),
    },
  );

  if (!res.ok) {
    return new Response(`subscribe failed: ${res.status}`, { status: 502 });
  }
  return Response.json({ ok: true });
}
