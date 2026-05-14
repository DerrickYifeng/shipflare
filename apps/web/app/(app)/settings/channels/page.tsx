/**
 * `/settings/channels` — list the founder's connected platforms.
 *
 * Server component (the user's own channel list lives in our D1; no need to
 * round-trip through CMO over MCP just to render a settings page). Reads
 * via Drizzle with an EXPLICIT projection so we never accidentally pull
 * `oauthTokenEncrypted` into the rendered HTML. Per CLAUDE.md token-read
 * invariant, only the sanctioned helpers in `apps/core/src/lib/channel.ts`
 * are allowed to touch the encrypted columns.
 *
 * The "Connect" links point at `/api/channels/<platform>/connect` which is
 * landed in S8. For now they're placeholders — clicking 404s, which is
 * fine. End-to-end OAuth flows arrive in the next sprint.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { channels, eq } from "@shipflare/db";
import type { CSSProperties } from "react";

// Force dynamic — D1 reads can't be cached and the result depends on the
// current session. Without this Next.js may try to prerender during build.
export const dynamic = "force-dynamic";

interface PlatformMeta {
  slug: "x" | "reddit";
  displayName: string;
  description: string;
}

const PLATFORMS: ReadonlyArray<PlatformMeta> = [
  {
    slug: "x",
    displayName: "X (Twitter)",
    description: "Drafts + replies on X",
  },
  {
    slug: "reddit",
    displayName: "Reddit",
    description: "Posts + comments on Reddit subreddits",
  },
];

export default async function ChannelsSettingsPage() {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/");
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);

  // EXPLICIT PROJECTION — do NOT select `oauthTokenEncrypted` /
  // `oauthRefreshEncrypted`. Per CLAUDE.md, only the sanctioned helpers
  // in `apps/core/src/lib/channel.ts` may read encrypted columns. Adding
  // them here (even just to discard them) is a review reject.
  const connected = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      username: channels.username,
      connectedAt: channels.connectedAt,
      lastVerifiedAt: channels.lastVerifiedAt,
      status: channels.status,
    })
    .from(channels)
    .where(eq(channels.userId, session.user.id));

  const connectedByPlatform = new Map(connected.map((c) => [c.platform, c]));

  return (
    <div>
      <h1>Channels</h1>
      <p style={{ color: "#666" }}>
        Connect platforms so your Social Media Manager can draft, reply, and
        post.
      </p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {PLATFORMS.map((p) => {
          const conn = connectedByPlatform.get(p.slug);
          return (
            <li key={p.slug} style={row}>
              <div style={{ flex: 1 }}>
                <strong>{p.displayName}</strong>
                <p style={{ color: "#666", margin: "0.25rem 0" }}>
                  {p.description}
                </p>
                {conn && (
                  <p style={{ color: "#0a7", fontSize: "0.875em", margin: "0.25rem 0" }}>
                    ✓ Connected
                    {conn.username ? ` as @${conn.username}` : ""}{" "}
                    <span style={{ color: "#888" }}>
                      ({new Date(conn.connectedAt).toLocaleDateString()})
                    </span>
                  </p>
                )}
              </div>
              <div>
                {conn ? (
                  <span style={{ color: "#888" }}>Connected</span>
                ) : (
                  <a
                    href={`/api/channels/${p.slug}/connect`}
                    style={connectBtn}
                  >
                    Connect {p.displayName}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p style={{ color: "#888", fontSize: "0.875em", marginTop: "2rem" }}>
        OAuth connect flows are wired in S8. The links above redirect to
        handlers that will exist after S8 lands.
      </p>
    </div>
  );
}

const row: CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
  display: "flex",
  alignItems: "center",
};
const connectBtn: CSSProperties = {
  display: "inline-block",
  padding: "0.5rem 1rem",
  background: "#000",
  color: "#fff",
  textDecoration: "none",
  borderRadius: 4,
};
