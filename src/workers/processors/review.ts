import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, threads, products, channels, userPreferences } from '@/lib/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { runForkSkill } from '@/skills/run-fork-skill';
import { reviewingDraftsOutputSchema } from '@/skills/reviewing-drafts/schema';
import { publishUserEvent } from '@/lib/redis';
import { enqueueDream, enqueuePosting } from '@/lib/queue';
import type { ReviewJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { addCost } from '@/lib/cost-bucket';

const baseLog = createLogger('worker:review');

export async function processReview(job: Job<ReviewJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, draftId, productId } = job.data;

  // Load draft + thread + product
  const [draft] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1);

  if (!draft) throw new Error(`Draft not found: ${draftId}`);

  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.id, draft.threadId))
    .limit(1);

  if (!thread) throw new Error(`Thread not found: ${draft.threadId}`);

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  log.info(`Reviewing draft ${draftId} for ${thread.community}`);

  // Load memory context
  const memoryStore = new MemoryStore(userId, productId);
  const dream = new AgentDream(memoryStore);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  try {
    const args = JSON.stringify({
      drafts: [
        {
          replyBody: draft.replyBody,
          threadTitle: thread.title,
          threadBody: thread.body ?? '',
          subreddit: thread.community,
          productName: product.name,
          productDescription: product.description,
          confidence: draft.confidenceScore,
          whyItWorks: draft.whyItWorks ?? '',
        },
      ],
      // Memory context appended for the model — the SKILL.md body reads this
      // explicitly under "Memory context". Replaces the prior pattern of
      // mutating the loaded agent's systemPrompt at call time.
      memoryContext: memoryPrompt ?? '',
    });

    const { result, usage } = await runForkSkill(
      'reviewing-drafts',
      args,
      reviewingDraftsOutputSchema,
    );
    await addCost(traceId, usage);

    log.info(`Review verdict: ${result.verdict}, score=${result.score.toFixed(2)}, cost=$${usage.costUsd.toFixed(4)}`);

    // Apply verdict
    const updateData: Record<string, unknown> = {
      reviewVerdict: result.verdict,
      reviewScore: result.score,
      reviewJson: { checks: result.checks, issues: result.issues, suggestions: result.suggestions },
      updatedAt: new Date(),
    };

    if (result.verdict === 'FAIL') {
      updateData.status = 'flagged';
    } else if (result.verdict === 'REVISE') {
      updateData.status = 'needs_revision';
    }
    // PASS: check auto-approve, otherwise keep as 'pending'

    let autoApproved = false;

    if (result.verdict === 'PASS') {
      const [prefs] = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);

      if (prefs?.autoApproveEnabled) {
        const draftType = draft.draftType ?? 'reply';
        const allowedTypes = (prefs.autoApproveTypes as string[]) ?? ['reply'];
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Count today's auto-approved drafts (approved drafts with no user interaction = auto)
        const [{ count: todayCount }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(drafts)
          .where(
            and(
              eq(drafts.userId, userId),
              eq(drafts.status, 'approved'),
              gte(drafts.updatedAt, today),
            ),
          );

        if (
          result.score >= prefs.autoApproveThreshold &&
          allowedTypes.includes(draftType) &&
          todayCount < prefs.maxAutoApprovalsPerDay
        ) {
          // Find the right channel for posting — only need id for enqueue
          const [channel] = await db
            .select({ id: channels.id })
            .from(channels)
            .where(
              and(
                eq(channels.userId, userId),
                eq(channels.platform, thread.platform ?? 'reddit'),
              ),
            )
            .limit(1);

          if (channel) {
            updateData.status = 'approved';
            autoApproved = true;
            log.info(
              `Auto-approving draft ${draftId}: score=${result.score.toFixed(2)} >= threshold=${prefs.autoApproveThreshold}, type=${draftType}`,
            );
          }
        }
      }
    }

    await db.update(drafts).set(updateData).where(eq(drafts.id, draftId));

    // Telemetry: stage='reviewed' (always). If the verdict marked the draft
    // as failed/flagged, also emit a 'failed' row so the funnel shows the
    // drop-off reason.
    await recordPipelineEvent({
      userId,
      productId,
      threadId: draft.threadId,
      draftId,
      stage: 'reviewed',
      cost: usage.costUsd,
      metadata: {
        verdict: result.verdict,
        score: result.score,
        autoApproved,
      },
    });
    if (result.verdict === 'FAIL') {
      await recordPipelineEvent({
        userId,
        productId,
        threadId: draft.threadId,
        draftId,
        stage: 'failed',
        metadata: {
          reason: 'review_flagged',
          verdict: result.verdict,
          issues: result.issues,
        },
      });
    }
    // Auto-approval is a terminal user-proxy decision; record it so the
    // funnel doesn't lose track of drafts that skip the manual approve step.
    if (autoApproved) {
      await recordPipelineEvent({
        userId,
        productId,
        threadId: draft.threadId,
        draftId,
        stage: 'approved',
        metadata: { autoApproved: true, score: result.score },
      });
    }

    // Enqueue posting for auto-approved drafts (after DB update)
    if (autoApproved) {
      const [channel] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.userId, userId),
            eq(channels.platform, thread.platform ?? 'reddit'),
          ),
        )
        .limit(1);

      if (channel) {
        // delayMs: 0 is intentional during the dispatcher migration window —
        // the pacer (Task 11) will replace this call with a paced enqueue.
        await enqueuePosting({ userId, draftId, channelId: channel.id, traceId }, { delayMs: 0 });
      }
    }

    // Publish SSE event
    await publishUserEvent(userId, 'drafts', {
      type: autoApproved ? 'draft_auto_approved' : 'draft_reviewed',
      draftId,
      verdict: result.verdict,
      score: result.score,
      community: thread.community,
      ...(autoApproved ? { autoApproved: true } : {}),
    });

    // Log insight
    await dream.logInsight(
      `Review of draft for ${thread.community} "${thread.title}" — verdict: ${result.verdict}, score: ${result.score}. Issues: ${result.issues.join('; ') || 'none'}`,
    );

    if (await dream.shouldDistill()) {
      await enqueueDream({ productId });
    }
  } catch (error) {
    // Fail-open: if review fails, leave draft as pending
    log.error(`Review failed for draft ${draftId}, leaving as pending: ${error instanceof Error ? error.message : String(error)}`);
  }
}
