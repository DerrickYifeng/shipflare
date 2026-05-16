import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { env } = getCloudflareContext();
  // SECURITY: spread `body` FIRST, then overwrite `userId` from the session.
  // Reversing this order would let an authenticated caller pass
  // `{ userId: "victim" }` in the body and inject events into another
  // user's CMO. Do not change this ordering without re-reviewing the
  // downstream `/internal/onboarding/strategic-path` handler.
  const coreRes = await env.CORE.fetch(
    "https://internal/internal/onboarding/strategic-path",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-shipflare-internal": "1" },
      body: JSON.stringify({ ...body, userId: session.user.id }),
    },
  );
  return new Response(coreRes.body, {
    status: coreRes.status,
    headers: coreRes.headers,
  });
}
