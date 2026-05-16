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
  const coreRes = await env.CORE.fetch(
    new Request(
      `https://internal/internal/onboarding/github-repos?userId=${encodeURIComponent(session.user.id)}`,
      {
        method: "GET",
        headers: { "x-shipflare-internal": "1" },
      },
    ),
  );
  return new Response(coreRes.body, {
    status: coreRes.status,
    headers: coreRes.headers,
  });
}
