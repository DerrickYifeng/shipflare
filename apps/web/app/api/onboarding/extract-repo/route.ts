import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { repoFullName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { env } = getCloudflareContext();
  const coreRes = await env.CORE.fetch(
    "https://internal/internal/onboarding/analyze-repo",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-shipflare-internal": "1" },
      body: JSON.stringify({
        userId: session.user.id,
        repoFullName: body.repoFullName ?? "",
      }),
    },
  );
  return new Response(coreRes.body, {
    status: coreRes.status,
    headers: coreRes.headers,
  });
}
