import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  channels,
  productRedditChannels,
  products,
} from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { GROWTH_MODULES } from '@/lib/growth-modules';
import { getPlatformConfig } from '@/lib/platform-config';
import { overallScore } from '@/lib/growth-score';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:growth:overview');

interface ChannelOut {
  platform: string;
  displayName: string;
  connected: boolean;
  handleOrLabel: string;
  score: number | null;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approveRate: number | null;
  lastPostAt: string | null;
  activeSubreddits?: string[];
}

interface ModuleOut {
  id: string;
  displayName: string;
  managerTitle: string;
  live: boolean;
  score: number | null;
  channels?: ChannelOut[];
}

interface GrowthOverviewResponse {
  overallScore: number | null;
  modules: ModuleOut[];
}

type LatestScoreRow = {
  platform: string;
  score: number;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approve_rate: number | null;
  last_post_at: Date | null;
} & Record<string, unknown>;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  log.info(`GET /api/growth/overview user=${userId}`);

  // Latest channel_scores per (userId, platform) — Postgres DISTINCT ON.
  const latestResult = await db.execute<LatestScoreRow>(sql`
    SELECT DISTINCT ON (platform)
      platform, score, threads, drafts, posts, replies, pending,
      approve_rate, last_post_at
    FROM channel_scores
    WHERE user_id = ${userId}
    ORDER BY platform, calculated_at DESC
  `);
  const latestRows = latestResult as unknown as LatestScoreRow[];
  const scoresByPlatform = new Map<string, LatestScoreRow>(
    latestRows.map((r) => [r.platform, r] as const),
  );

  // Explicit projection — never read token columns (CLAUDE.md security rule).
  const channelRows = await db
    .select({
      platform: channels.platform,
      username: channels.username,
    })
    .from(channels)
    .where(eq(channels.userId, userId));
  const connectedByPlatform = new Map<
    string,
    { platform: string; username: string | null }
  >(channelRows.map((c) => [c.platform, c] as const));

  // Active subreddits, top 5 by rank (for Reddit channel chips).
  const productResult = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  const product = productResult[0];

  let activeSubreddits: string[] = [];
  if (product) {
    const subs = await db
      .select({ subreddit: productRedditChannels.subreddit })
      .from(productRedditChannels)
      .where(
        and(
          eq(productRedditChannels.productId, product.id),
          eq(productRedditChannels.disabled, false),
        ),
      )
      .orderBy(productRedditChannels.rank)
      .limit(5);
    activeSubreddits = subs.map((s) => s.subreddit);
  }

  const modules: ModuleOut[] = GROWTH_MODULES.map((mod) => {
    if (!mod.live) {
      return {
        id: mod.id,
        displayName: mod.displayName,
        managerTitle: mod.managerTitle,
        live: false,
        score: null,
      };
    }
    const chans: ChannelOut[] = mod.channels.map((platform) => {
      const cfg = getPlatformConfig(platform);
      const score = scoresByPlatform.get(platform);
      const connection = connectedByPlatform.get(platform);
      // Reddit is no-binding always-on (handoff mode): no channels row is
      // ever written, but the founder ships content through their own
      // browser via the handoff flow. Always render it as connected.
      const isAlwaysOn = platform === 'reddit';
      const connected = isAlwaysOn || !!connection;
      const handleOrLabel = isAlwaysOn
        ? 'Handoff mode'
        : connection?.username
          ? `@${connection.username}`
          : 'Not connected';
      const out: ChannelOut = {
        platform,
        displayName: cfg.displayName,
        connected,
        handleOrLabel,
        score: score ? score.score : null,
        threads: score?.threads ?? 0,
        drafts: score?.drafts ?? 0,
        posts: score?.posts ?? 0,
        replies: score?.replies ?? 0,
        pending: score?.pending ?? 0,
        approveRate: score?.approve_rate ?? null,
        lastPostAt: score?.last_post_at
          ? new Date(score.last_post_at).toISOString()
          : null,
      };
      if (platform === 'reddit') {
        out.activeSubreddits = activeSubreddits;
      }
      return out;
    });
    const channelScoresVals = chans
      .map((c) => c.score)
      .filter((s): s is number => typeof s === 'number');
    const moduleScoreVal =
      channelScoresVals.length > 0
        ? Math.round(
            channelScoresVals.reduce((a, b) => a + b, 0) /
              channelScoresVals.length,
          )
        : null;
    return {
      id: mod.id,
      displayName: mod.displayName,
      managerTitle: mod.managerTitle,
      live: true,
      score: moduleScoreVal,
      channels: chans,
    };
  });

  const liveScored = modules.filter(
    (m): m is ModuleOut & { score: number } =>
      m.live && m.score !== null,
  );
  const weight = liveScored.length > 0 ? 1 / liveScored.length : 0;
  const overall =
    liveScored.length > 0
      ? overallScore(liveScored.map((m) => ({ score: m.score, weight })))
      : null;

  const body: GrowthOverviewResponse = {
    overallScore: overall,
    modules,
  };
  return NextResponse.json(body);
}
