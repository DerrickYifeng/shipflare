import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { getGitHubToken, listUserRepos } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { env } = getCloudflareContext();
  const db = getDb(env);
  const token = await getGitHubToken(db, session.user.id);
  if (!token) {
    return NextResponse.json(
      { error: "No GitHub account linked" },
      { status: 404 },
    );
  }
  try {
    const repos = await listUserRepos(token);
    return NextResponse.json({ repos, username: session.user.name ?? null });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch repos";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
