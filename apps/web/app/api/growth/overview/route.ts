/**
 * `/api/growth/overview` — GET the current user's growth overview.
 *
 * Reads the latest `growth_snapshots` row per platform for the signed-in
 * user plus their active channel connections, and returns a shape that the
 * Growth page (Task 6.4) consumes.
 *
 * GET → GrowthOverview JSON
 *
 * Session-gated via Better Auth. Read-only — no PATCH/POST/DELETE.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { and, eq, channels, growthSnapshots } from "@shipflare/db";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Platform = "x" | "reddit";

const PLATFORMS: readonly Platform[] = ["x", "reddit"] as const;

interface ChannelCard {
  platform: Platform;
  live: boolean;
  username: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
}

interface GrowthModule {
  id: string;
  displayName: string;
  managerTitle: string;
  live: boolean;
  score: number;
  channels: ChannelCard[];
}

interface GrowthOverview {
  overallScore: number;
  modules: GrowthModule[];
}

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb(env);
  const userId = session.user.id;

  // Load connected channels for this user (any status — we want to show
  // whether the user has ever connected a platform, not just active ones).
  const userChannels = await db
    .select({ platform: channels.platform, username: channels.username })
    .from(channels)
    .where(eq(channels.userId, userId))
    .all();

  // For each platform, fetch the most recent snapshot (if any).
  const cards: ChannelCard[] = await Promise.all(
    PLATFORMS.map(async (platform) => {
      const snap = await db
        .select()
        .from(growthSnapshots)
        .where(
          and(
            eq(growthSnapshots.userId, userId),
            eq(growthSnapshots.platform, platform),
          ),
        )
        .orderBy(desc(growthSnapshots.capturedAt))
        .limit(1)
        .get();

      const channel = userChannels.find((c) => c.platform === platform);

      return {
        platform,
        live: Boolean(channel),
        username: channel?.username ?? null,
        metrics: snap?.metrics ?? {},
        capturedAt: snap?.capturedAt ? snap.capturedAt.toISOString() : null,
      };
    }),
  );

  const liveCount = cards.filter((c) => c.live).length;

  // Crude score placeholder — real scoring lands in a follow-up task.
  const score = liveCount * 50;

  const body: GrowthOverview = {
    overallScore: score,
    modules: [
      {
        id: "social",
        displayName: "Social",
        managerTitle: "Social Media Manager",
        live: cards.some((c) => c.live),
        score,
        channels: cards,
      },
    ],
  };

  return NextResponse.json(body);
}
