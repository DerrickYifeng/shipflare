import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { env } = getCloudflareContext();
  // Pass (url, init) instead of `new Request(...)` — OpenNext's dev-mode
  // service-binding shim doesn't accept a Request object and throws
  // "Failed to parse URL from [object Request]".
  const coreRes = await env.CORE.fetch(
    `https://internal/internal/onboarding/github-repos?userId=${encodeURIComponent(session.user.id)}`,
    {
      method: "GET",
      headers: { "x-shipflare-internal": "1" },
    },
  );
  return new Response(coreRes.body, {
    status: coreRes.status,
    headers: coreRes.headers,
  });
}
