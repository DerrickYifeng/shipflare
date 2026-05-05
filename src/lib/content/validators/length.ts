// twitter-text v3.x only ships `export default { parseTweet, ... }` in its
// ESM build (dist/esm/index.js). The CJS build exposed named exports via
// Babel's add-module-exports plugin, which Webpack tolerated; Turbopack's
// ESM resolver is strict and rejects `import { parseTweet }`. Default-import
// the namespace and destructure once at module load.
import twitterText from 'twitter-text';
const { parseTweet } = twitterText;
import {
  getPlatformCharLimits,
  type ContentKind,
} from '@/lib/platform-config';

const X_PLATFORM = 'x';
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

export interface ReplyLengthResult {
  ok: boolean;
  /** Machine-readable reason code when `ok === false`. */
  reason?: 'too_long';
  /** Excess over the cap (0 when within the limit). */
  excess: number;
  /** Resolved char limit for the platform + kind, returned for UI display. */
  limit: number;
  /** Length used for the headline check. */
  length: number;
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
 * - For X replies with `hasLeadingMentions: true`, strips the leading
 *   `@handle` run before measuring (Twitter excludes it from the cap).
 * - For Reddit and any future platforms, falls back to codepoint counting.
 */
export function validateReplyLength(
  text: string,
  { platform, kind, hasLeadingMentions }: ReplyLengthOptions,
): ReplyLengthResult {
  const limit = getPlatformCharLimits(platform, kind);
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
  };
}
