import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import { voiceProfiles } from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import {
  voiceExtractorOutputSchema,
  type VoiceExtractorOutput,
} from '@/agents/schemas';
import { createPlatformDeps } from '@/lib/platform-deps';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { XClient } from '@/lib/x-client';
import type { VoiceExtractJobData } from '@/lib/queue/voice-extract';
import { getTraceId } from '@/lib/queue/types';

const baseLog = createLogger('worker:voice-extract');

const extractorSkill = loadSkill(
  join(process.cwd(), 'src/skills/voice-extractor'),
);

/**
 * Max number of engagement-ranked tweets to pass to the extractor.
 * Keeps prompt size predictable and avoids token blowout.
 */
const SAMPLE_LIMIT = 30;

/**
 * Compute a single engagement score from X public metrics.
 * Bookmarks and likes are weighted most — they're the strongest
 * signal of value for voice calibration.
 */
function computeEngagement(metrics?: {
  retweets: number;
  replies: number;
  likes: number;
  quotes: number;
  bookmarks: number;
  impressions: number;
}): number {
  if (!metrics) return 0;
  return (
    metrics.bookmarks * 3 +
    metrics.likes * 2 +
    metrics.retweets * 2 +
    metrics.quotes +
    metrics.replies
  );
}

export async function processVoiceExtract(job: Job<VoiceExtractJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, channel } = job.data;

  // Load the user's voice profile.
  const [profile] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    log.warn(`voice profile for ${userId} not found — run onboarding first`);
    return;
  }

  // Resolve X client via the sanctioned helper (see CLAUDE.md Security TODO).
  const deps = await createPlatformDeps(channel, userId);
  const xClient = deps.xClient as XClient | undefined;
  if (!xClient) {
    log.warn(`no xClient for ${userId}; skipping extraction`);
    return;
  }

  // Resolve the X platform user ID so we can fetch their timeline.
  const me = await xClient.getMe();

  // Fetch up to 200 recent tweets (X API max per call).
  const { tweets: rawTweets } = await xClient.getUserTweets(me.id, {
    maxResults: 200,
  });

  // Rank by engagement and cap at SAMPLE_LIMIT.
  const ranked = rawTweets
    .map((t) => ({
      id: t.id,
      text: t.text,
      engagement: computeEngagement(t.metrics),
    }))
    .sort((a, b) => b.engagement - a.engagement);

  const samples = ranked.slice(0, SAMPLE_LIMIT);

  // Run the voice-extractor skill.
  const res = await runSkill<VoiceExtractorOutput>({
    skill: extractorSkill,
    input: {
      structured: {
        register: profile.register,
        pronouns: profile.pronouns,
        capitalization: profile.capitalization,
        emojiPolicy: profile.emojiPolicy,
        signatureEmoji: profile.signatureEmoji,
        punctuationSignatures: profile.punctuationSignatures,
        humorRegister: profile.humorRegister,
        bannedWords: profile.bannedWords,
        bannedPhrases: profile.bannedPhrases,
        worldviewTags: profile.worldviewTags,
        openerPreferences: profile.openerPreferences,
        closerPolicy: profile.closerPolicy,
      },
      samples,
    },
    deps: {},
    outputSchema: voiceExtractorOutputSchema,
    runId: traceId,
  });

  if (res.errors.length > 0 || !res.results[0]) {
    log.warn(
      `voice extraction failed for ${userId}: ${res.errors[0]?.error ?? 'no result'}`,
    );
    return;
  }

  const extract = res.results[0];
  const nextVersion = profile.extractionVersion + 1;

  // Build the update payload. Stats + histograms are always refreshed.
  // The style card is only written when the user has NOT manually edited it —
  // we never overwrite a user-curated card.
  const updateSet: Record<string, unknown> = {
    sampleTweets: samples,
    avgSentenceLength: extract.avgSentenceLength,
    lengthHistogram: extract.lengthHistogram,
    openerHistogram: extract.openerHistogram,
    extractionVersion: nextVersion,
    lastExtractedAt: new Date(),
    updatedAt: new Date(),
  };

  if (!profile.styleCardEdited) {
    updateSet.extractedStyleCardMd = extract.styleCardMd;
    // Merge detected banned words additively — never remove existing entries.
    const merged = Array.from(
      new Set([...profile.bannedWords, ...extract.detectedBannedWords]),
    );
    updateSet.bannedWords = merged;
  }

  await db
    .update(voiceProfiles)
    .set(updateSet)
    .where(eq(voiceProfiles.id, profile.id));

  await recordPipelineEvent({
    userId,
    stage: 'voice_extracted',
    cost: res.usage.costUsd,
    metadata: {
      channel,
      sampleCount: samples.length,
      version: nextVersion,
      triggerReason: job.data.triggerReason,
    },
  });

  log.info(
    `voice profile ${profile.id} refreshed (v${nextVersion}, ${samples.length} samples, cost $${res.usage.costUsd.toFixed(4)})`,
  );
}
