import type { Metadata } from "next";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { RedditChannelsContent } from "./reddit-channels-content";

export const metadata: Metadata = { title: "Reddit communities" };
export const dynamic = "force-dynamic";

/**
 * /growth/reddit-channels — read-only view of the top-3 subreddits that
 * SMM's `research_reddit_channels` tool writes to CMO's founder_context.
 *
 * Reachable from the Reddit card on /growth ("Manage subreddits →").
 * Auth gate is handled by (app)/layout.tsx; we double-check here so the
 * server component never renders with an anonymous session, and so we
 * can plumb `userId` + `coreHost` down to the client component (Task 11
 * — callable RPC migration).
 */
export default async function RedditChannelsPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[RedditChannelsPage] getSession failed", err);
  }
  if (!session?.user) return null;
  return (
    <RedditChannelsContent
      userId={session.user.id}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
