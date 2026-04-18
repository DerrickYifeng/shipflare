import type { ContentKind } from '@/lib/platform-config';
import { validateHallucinatedStats } from './hallucinated-stats';
import { validateReplyLength } from './length';
import { validatePlatformLeak } from './platform-leak';

export interface ContentValidatorInput {
  text: string;
  platform: string;
  kind: ContentKind;
}

export type ContentValidatorFailure =
  | {
      validator: 'length';
      reason: 'too_long';
      limit: number;
      length: number;
      excess: number;
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

export interface ContentValidatorResult {
  ok: boolean;
  failures: ContentValidatorFailure[];
}

/**
 * Run every validator and aggregate the failures. Never short-circuits —
 * the caller almost always wants the full list so it can surface all the
 * reasons a draft was rejected in one pass rather than playing whack-a-mole.
 */
export function runContentValidators(
  input: ContentValidatorInput,
): ContentValidatorResult {
  const failures: ContentValidatorFailure[] = [];

  const length = validateReplyLength(input.text, {
    platform: input.platform,
    kind: input.kind,
  });
  if (!length.ok) {
    failures.push({
      validator: 'length',
      reason: 'too_long',
      limit: length.limit,
      length: length.length,
      excess: length.excess ?? 0,
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

  return { ok: failures.length === 0, failures };
}
