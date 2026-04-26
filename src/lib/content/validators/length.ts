import { parseTweet } from 'twitter-text';
import {
  getPlatformCharLimits,
  type ContentKind,
} from '@/lib/platform-config';

const X_PLATFORM = 'x';
const X_THREAD_MAX_TWEETS = 25;
/**
 * Splits the bundled "thread" body that `draft_post` produces. Tweets in a
 * draft thread are joined by a blank-line separator; treat any run of two
 * or more newlines as the segment boundary so we don't false-split a single
 * tweet that happens to contain a soft newline.
 */
const X_THREAD_SEGMENT_SEPARATOR = /\n{2,}/;
/**
 * Auto-prepended @mentions on a reply ("@alice @bob hi") don't count toward
 * the 280 cap. We strip a leading run of mentions before measuring; anything
 * mid-text counts normally.
 */
const LEADING_MENTIONS_RE = /^(\s*@[A-Za-z0-9_]{1,15}\s+)+/;

export interface ReplyLengthOptions {
  platform: string;
  kind: ContentKind;
  /**
   * For X replies: when the body is the founder-typed copy that will be sent
   * after Twitter auto-prepends `@author`, leading mention prefixes don't
   * count. Set true to strip leading `@handle` runs before measuring. Default
   * false because most agent drafts don't include the auto-mention prefix.
   */
  hasLeadingMentions?: boolean;
}

export interface SegmentLengthResult {
  index: number;
  text: string;
  ok: boolean;
  reason?: 'too_long';
  /** Weighted length on X; codepoint length on other platforms. */
  length: number;
  limit: number;
  excess: number;
}

export interface ReplyLengthResult {
  ok: boolean;
  /** Machine-readable reason code when `ok === false`. */
  reason?: 'too_long' | 'too_many_segments';
  /** Excess over the cap (0 when within the limit). For threads: max segment excess. */
  excess: number;
  /** Resolved char limit for the platform + kind, returned for UI display. */
  limit: number;
  /** Length used for the headline check (max segment length for threads). */
  length: number;
  /** Per-tweet results when the input is a multi-segment X post (thread). */
  segments?: SegmentLengthResult[];
  /** Number of thread segments detected (1 for non-threads). */
  segmentCount: number;
  /** True iff the input was treated as a multi-segment X thread. */
  isThread: boolean;
}

/** twitter-text weighted length for a single tweet's worth of text. */
function weightedXLength(text: string): number {
  return parseTweet(text).weightedLength;
}

/** Codepoint length (Reddit, fallback). */
function codepointLength(text: string): number {
  return [...text].length;
}

function measure(text: string, platform: string): number {
  return platform === X_PLATFORM ? weightedXLength(text) : codepointLength(text);
}

function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS_RE, '');
}

/**
 * Validate that `text` fits inside the platform's cap for the given content
 * kind.
 *
 * - On X, uses `twitter-text.parseTweet` so URLs (t.co=23), emoji (2), and
 *   CJK (2) are weighted the way Twitter actually counts them. NFC-normalized.
 * - For X posts containing a `\n\n+` separator, treats the body as a thread
 *   and validates each segment against the per-tweet cap (also enforces the
 *   25-tweet thread ceiling).
 * - For X replies with `hasLeadingMentions: true`, strips the leading
 *   `@handle` run before measuring (Twitter excludes it from the cap).
 * - For Reddit and any future platforms, falls back to codepoint counting.
 */
export function validateReplyLength(
  text: string,
  { platform, kind, hasLeadingMentions }: ReplyLengthOptions,
): ReplyLengthResult {
  const limit = getPlatformCharLimits(platform, kind);

  // X post + thread shape (body has a blank-line separator) → segment-aware.
  if (
    platform === X_PLATFORM &&
    kind === 'post' &&
    X_THREAD_SEGMENT_SEPARATOR.test(text)
  ) {
    const rawSegments = text
      .split(X_THREAD_SEGMENT_SEPARATOR)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const segments: SegmentLengthResult[] = rawSegments.map((seg, i) => {
      const length = weightedXLength(seg);
      const excess = Math.max(0, length - limit);
      return {
        index: i,
        text: seg,
        ok: length <= limit,
        reason: length > limit ? ('too_long' as const) : undefined,
        length,
        limit,
        excess,
      };
    });

    const tooMany = segments.length > X_THREAD_MAX_TWEETS;
    const anyOver = segments.some((s) => !s.ok);
    const headlineLength = segments.length > 0
      ? Math.max(...segments.map((s) => s.length))
      : 0;
    const headlineExcess = segments.length > 0
      ? Math.max(...segments.map((s) => s.excess))
      : 0;

    return {
      ok: !tooMany && !anyOver,
      reason: tooMany
        ? 'too_many_segments'
        : anyOver
          ? 'too_long'
          : undefined,
      excess: headlineExcess,
      limit,
      length: headlineLength,
      segments,
      segmentCount: segments.length,
      isThread: true,
    };
  }

  // Single-segment path: X post (no thread), X reply, Reddit post / reply.
  const measureText =
    platform === X_PLATFORM && kind === 'reply' && hasLeadingMentions
      ? stripLeadingMentions(text)
      : text;
  const length = measure(measureText, platform);
  const excess = Math.max(0, length - limit);
  return {
    ok: length <= limit,
    reason: length > limit ? 'too_long' : undefined,
    excess,
    limit,
    length,
    segmentCount: 1,
    isThread: false,
  };
}
