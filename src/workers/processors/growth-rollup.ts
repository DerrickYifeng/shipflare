import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { channelScores, moduleScores } from '@/lib/db/schema';
import { listAvailablePlatforms } from '@/lib/platform-config';
import { GROWTH_TARGETS } from '@/lib/growth-targets';
import { liveModules } from '@/lib/growth-modules';
import {
  channelScore,
  moduleScore,
  type ChannelCounts,
} from '@/lib/growth-score';
import {
  countThreads,
  countDrafts,
  countPosts,
  countReplies,
  countPending,
  countApprovedSkipped,
  lastPostAt,
  WEEK_MS,
} from './lib/growth-counts';
import type { GrowthRollupJobData } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';

const baseLog = createLogger('worker:growth-rollup');

/**
 * Per-user rollup: counts → channel scores → module scores.
 * The cron fanout (kind: 'fanout') is handled by a separate processor
 * (Task 8 — growth-rollup-fanout.ts).
 */
export async function processGrowthRollup(job: Job<GrowthRollupJobData>) {
  const log = loggerForJob(baseLog, job);

  if (job.data.kind === 'fanout') {
    log.warn('growth-rollup user processor received a fanout payload; ignoring');
    return;
  }

  const { userId } = job.data;
  const weekAgo = new Date(Date.now() - WEEK_MS);
  log.info(`Computing growth rollup for user=${userId}`);

  const channelScoresByPlatform = new Map<string, number>();

  for (const platform of listAvailablePlatforms()) {
    const target = GROWTH_TARGETS[platform];
    if (!target) {
      log.warn(`No GROWTH_TARGETS entry for platform=${platform}; skipping`);
      continue;
    }

    const [
      threadCount,
      draftCount,
      postCount,
      replyCount,
      pendingCount,
      approveAgg,
      lastPost,
    ] = await Promise.all([
      countThreads(userId, platform, weekAgo),
      countDrafts(userId, platform, weekAgo),
      countPosts(userId, platform, weekAgo),
      countReplies(userId, platform, weekAgo),
      countPending(userId, platform),
      countApprovedSkipped(userId, platform, weekAgo),
      lastPostAt(userId, platform),
    ]);

    const counts: ChannelCounts = {
      threads: threadCount,
      drafts: draftCount,
      posts: postCount,
      replies: replyCount,
    };
    const score = channelScore(counts, target);
    const approveDecisions = approveAgg.approved + approveAgg.skipped;
    const approveRate =
      approveDecisions > 0 ? approveAgg.approved / approveDecisions : null;

    await db.insert(channelScores).values({
      userId,
      platform,
      score,
      threads: counts.threads,
      drafts: counts.drafts,
      posts: counts.posts,
      replies: counts.replies,
      pending: pendingCount,
      approveRate,
      lastPostAt: lastPost,
    });

    channelScoresByPlatform.set(platform, score);
  }

  // Per-module rollup (live modules only).
  for (const module of liveModules()) {
    const scores = module.channels
      .map((p) => channelScoresByPlatform.get(p))
      .filter((s): s is number => typeof s === 'number');
    if (scores.length === 0) continue;
    const score = moduleScore(scores);
    await db.insert(moduleScores).values({
      userId,
      moduleId: module.id,
      score,
    });
  }

  log.info(`Done growth rollup for user=${userId}`);
}
