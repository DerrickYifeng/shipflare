import type { ContentKind } from '@/lib/platform-config';
import { validateHallucinatedStats } from './hallucinated-stats';
import { validateReplyLength } from './length';
import { validatePlatformLeak } from './platform-leak';
import {
  validateHashtagCount,
  validateLinksInPostBody,
  validateLinksInReply,
} from './editorial';
import { validateAnchorToken } from '@/lib/reply/anchor-token-validator';

export interface ContentValidatorInput {
  text: string;
  platform: string;
  kind: ContentKind;
  /**
   * X reply only — strip leading `@handle` runs before measuring length.
   * Twitter excludes the auto-prepended mentions from the 280 cap.
   */
  hasLeadingMentions?: boolean;
}

/**
 * Hard failures — the content cannot ship as-is. Either the platform will
 * reject it (length, NFC, etc.) or shipping it would damage the founder's
 * reputation across platforms (sibling-platform leak, hallucinated stats).
 */
export type ContentValidatorFailure =
  | {
      validator: 'length';
      reason: 'too_long' | 'too_many_segments';
      limit: number;
      length: number;
      excess: number;
      /** Per-tweet results when the input was an X thread. */
      segments?: Array<{
        index: number;
        text: string;
        ok: boolean;
        length: number;
        excess: number;
      }>;
      isThread: boolean;
      segmentCount: number;
    }
  | {
      validator: 'platform_leak';
      reason: 'mentions_other_platform';
      leakedPlatforms: string[];
      matches: Array<{ term: string; platform: string; sentence: string }>;
    }
  | {
      validator: 'hallucinated_stats';
      reason: 'unsourced_stats';
      flaggedClaims: string[];
    };

/**
 * Soft failures — ShipFlare style violations. The platform will accept
 * the post; we'd rather the agent rewrite than ship it. Surfaced separately
 * from `failures` so callers can distinguish "X will reject" from
 * "we'd rather not ship this".
 */
export type ContentValidatorWarning =
  | {
      validator: 'hashtag_count';
      reason: 'out_of_bounds';
      count: number;
      hashtags: string[];
      min: number;
      max: number;
    }
  | {
      validator: 'links_in_reply';
      reason: 'links_forbidden_in_reply';
      urls: string[];
    }
  | {
      validator: 'links_in_post_body';
      reason: 'use_first_reply_link';
      urls: string[];
    }
  | {
      validator: 'anchor_token';
      reason: 'no_anchor';
    };

export interface ContentValidatorResult {
  ok: boolean;
  failures: ContentValidatorFailure[];
  warnings: ContentValidatorWarning[];
}

/**
 * Run every validator and aggregate the results. Never short-circuits — the
 * caller almost always wants the full list so it can surface every reason a
 * draft was rejected in one pass rather than playing whack-a-mole.
 *
 * `ok` reflects HARD failures only (`failures.length === 0`). Warnings do
 * not fail the validation pass — callers decide whether to repair them.
 */
export function runContentValidators(
  input: ContentValidatorInput,
): ContentValidatorResult {
  const failures: ContentValidatorFailure[] = [];
  const warnings: ContentValidatorWarning[] = [];

  // --- Hard failures (platform rejects / cross-platform reputation) -----

  const length = validateReplyLength(input.text, {
    platform: input.platform,
    kind: input.kind,
    hasLeadingMentions: input.hasLeadingMentions,
  });
  if (!length.ok) {
    failures.push({
      validator: 'length',
      reason: length.reason ?? 'too_long',
      limit: length.limit,
      length: length.length,
      excess: length.excess,
      segments: length.segments?.map((s) => ({
        index: s.index,
        text: s.text,
        ok: s.ok,
        length: s.length,
        excess: s.excess,
      })),
      isThread: length.isThread,
      segmentCount: length.segmentCount,
    });
  }

  const leak = validatePlatformLeak(input.text, {
    targetPlatform: input.platform,
  });
  if (!leak.ok) {
    failures.push({
      validator: 'platform_leak',
      reason: 'mentions_other_platform',
      leakedPlatforms: leak.leakedPlatforms,
      matches: leak.matches,
    });
  }

  const stats = validateHallucinatedStats(input.text);
  if (!stats.ok) {
    failures.push({
      validator: 'hallucinated_stats',
      reason: 'unsourced_stats',
      flaggedClaims: stats.flaggedClaims,
    });
  }

  // --- Soft failures (editorial style) ----------------------------------

  const hashtags = validateHashtagCount(input.text, input.platform, input.kind);
  if (!hashtags.ok) {
    warnings.push({
      validator: 'hashtag_count',
      reason: 'out_of_bounds',
      count: hashtags.count,
      hashtags: hashtags.hashtags,
      min: hashtags.min,
      max: hashtags.max,
    });
  }

  const linksInReply = validateLinksInReply(
    input.text,
    input.platform,
    input.kind,
  );
  if (!linksInReply.ok) {
    warnings.push({
      validator: 'links_in_reply',
      reason: 'links_forbidden_in_reply',
      urls: linksInReply.urls,
    });
  }

  const linksInPost = validateLinksInPostBody(
    input.text,
    input.platform,
    input.kind,
  );
  if (!linksInPost.ok) {
    warnings.push({
      validator: 'links_in_post_body',
      reason: 'use_first_reply_link',
      urls: linksInPost.urls,
    });
  }

  // Anchor token only applies to X replies.
  if (input.platform === 'x' && input.kind === 'reply') {
    const anchor = validateAnchorToken(input.text);
    if (!anchor.pass) {
      warnings.push({ validator: 'anchor_token', reason: 'no_anchor' });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
  };
}
