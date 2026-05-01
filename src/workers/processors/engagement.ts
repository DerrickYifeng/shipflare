import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  products,
  drafts,
  posts,
  threads,
  activityEvents,
} from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { createPlatformDeps } from '@/lib/platform-deps';
import { runForkSkill } from '@/skills/run-fork-skill';
import { monitoringEngagementOutputSchema } from '@/skills/monitoring-engagement/schema';
import { enqueueReview } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import type { EngagementJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';
import { buildContentUrl } from '@/lib/platform-config';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const MAX_ENGAGEMENT_DEPTH = 2;

const baseLog = createLogger('worker:x-engagement');

export async function processXEngagement(job: Job<EngagementJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, contentId: tweetId, productId } = job.data;
  const legacyContentText = (job.data as { contentText?: string }).contentText;
  const explicitDraftId = (job.data as { draftId?: string }).draftId;
  log.info(`Monitoring engagement for tweet ${tweetId}`);

  // Resolve X client via createPlatformDeps — sanctioned path for token-column
  // access (see CLAUDE.md → Security TODO item 2).
  const deps = await createPlatformDeps('x', userId);
  const xClient = deps.xClient as XClient | undefined;
  if (!xClient) throw new Error('No X channel connected');

  // Resolve the original posted text via DB lookup (payloads no longer carry
  // contentText). Order of resolution:
  //   1. Explicit draftId in payload
  //   2. posts.externalId === tweetId → draft
  //   3. legacy contentText field (for in-flight jobs enqueued before the
  //      schema update)
  let originalText = '';
  if (explicitDraftId) {
    const [d] = await db
      .select({ replyBody: drafts.replyBody })
      .from(drafts)
      .where(eq(drafts.id, explicitDraftId))
      .limit(1);
    originalText = d?.replyBody ?? '';
  }
  if (!originalText) {
    const [postRow] = await db
      .select({ draftId: posts.draftId })
      .from(posts)
      .where(eq(posts.externalId, tweetId))
      .limit(1);
    if (postRow?.draftId) {
      const [d] = await db
        .select({ replyBody: drafts.replyBody })
        .from(drafts)
        .where(eq(drafts.id, postRow.draftId))
        .limit(1);
      originalText = d?.replyBody ?? '';
    }
  }
  if (!originalText && legacyContentText) {
    // Back-compat for jobs enqueued before the payload change. Remove after
    // the engagement queue has drained (scheduled checks are at +15/30/60m).
    originalText = legacyContentText;
  }
  if (!originalText) {
    log.warn(
      `No original text resolvable for tweet ${tweetId}; skipping engagement monitor`,
    );
    return;
  }

  // Get authenticated user ID
  let xUserId: string;
  try {
    const me = await xClient.getMe();
    xUserId = me.id;
  } catch {
    log.error('Failed to get authenticated user ID');
    return;
  }

  // Load product name for agent context
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  const productName = product?.name ?? 'ShipFlare';

  // Run the monitoring-engagement skill (fork-mode). Preserve the JSON
  // input shape character-for-character — the SKILL.md prompt expects
  // these exact fields. xClient is forwarded via deps so the
  // x_get_mentions / x_get_tweet tools can resolve their platform client.
  const args = JSON.stringify({
    platform: 'x',
    tweetId,
    originalText,
    userId: xUserId,
    productName,
  });

  try {
    const { result, usage } = await runForkSkill(
      'monitoring-engagement',
      args,
      monitoringEngagementOutputSchema,
      { xClient },
    );

    const actionableMentions = result.mentions.filter((m) => m.shouldReply);

    log.info(
      `Found ${result.mentions.length} mentions, ${actionableMentions.length} actionable, cost $${usage.costUsd.toFixed(4)}`,
    );

    // Look up the original posted draft to inherit engagement depth
    let parentDepth = 0;
    const [parentPost] = await db
      .select({ draftId: posts.draftId })
      .from(posts)
      .where(eq(posts.externalId, tweetId))
      .limit(1);

    if (parentPost) {
      const [parentDraft] = await db
        .select({ engagementDepth: drafts.engagementDepth })
        .from(drafts)
        .where(eq(drafts.id, parentPost.draftId))
        .limit(1);
      parentDepth = parentDraft?.engagementDepth ?? 0;
    }

    const childDepth = parentDepth + 1;

    if (childDepth > MAX_ENGAGEMENT_DEPTH) {
      log.info(
        `Skipping engagement draft creation for tweet ${tweetId}: depth ${childDepth} exceeds max ${MAX_ENGAGEMENT_DEPTH}`,
      );
      return;
    }

    // Create drafts for actionable mentions
    let draftsCreated = 0;
    for (const mention of actionableMentions) {
      if (!mention.draftReply) continue;

      // Create thread record for the mention
      const [threadRecord] = await db
        .insert(threads)
        .values({
          userId,
          externalId: mention.mentionId,
          platform: 'x',
          community: `@${mention.authorUsername}`,
          title: mention.text.slice(0, 200),
          url: buildContentUrl('x', mention.authorUsername, mention.mentionId),
          scoutConfidence:
            mention.priority === 'high'
              ? 0.9
              : mention.priority === 'medium'
                ? 0.7
                : 0.5,
          scoutReason: `engagement-mention (${mention.priority})`,
        })
        .onConflictDoNothing()
        .returning();

      if (!threadRecord) continue;

      const [draft] = await db
        .insert(drafts)
        .values({
          userId,
          threadId: threadRecord.id,
          draftType: 'reply',
          replyBody: mention.draftReply,
          confidenceScore:
            mention.priority === 'high'
              ? 0.9
              : mention.priority === 'medium'
                ? 0.7
                : 0.5,
          whyItWorks: `${mention.priority} priority engagement reply to @${mention.authorUsername}`,
          engagementDepth: childDepth,
        })
        .returning();

      draftsCreated++;

      // Telemetry: stage='engaged' — an engagement-reply draft was created
      // in response to a mention. Distinct from 'draft_created' so the
      // funnel can show engagement-driven drafts separately.
      await recordPipelineEvent({
        userId,
        productId,
        threadId: threadRecord.id,
        draftId: draft.id,
        stage: 'engaged',
        metadata: {
          tweetId,
          priority: mention.priority,
          authorUsername: mention.authorUsername,
        },
      });

      // Auto-enqueue review
      await enqueueReview({
        userId,
        draftId: draft.id,
        productId,
        traceId,
      });

      // (Phase 2 migration: todo_items table dropped. plan_items injection for
      // engagement-triggered replies lands with the plan-execute dispatcher in
      // Phase 7.)
    }

    // Publish SSE event for high-priority engagement
    if (actionableMentions.some((m) => m.priority === 'high')) {
      await publishUserEvent(userId, 'tweets', {
        type: 'engagement_alert',
        tweetId,
        highPriorityCount: actionableMentions.filter(
          (m) => m.priority === 'high',
        ).length,
        totalMentions: result.mentions.length,
        draftsCreated,
      });
    }

    // Log activity
    await db.insert(activityEvents).values({
      userId,
      eventType: 'x_engagement_check',
      metadataJson: {
        tweetId,
        mentionsFound: result.mentions.length,
        actionable: actionableMentions.length,
        draftsCreated,
        cost: usage.costUsd,
      },
    });
  } catch (err) {
    if (err instanceof XForbiddenError) {
      log.warn('X API 403 — Basic tier required for getMentions. Skipping engagement monitoring.');
      return;
    }
    throw err;
  }
}
