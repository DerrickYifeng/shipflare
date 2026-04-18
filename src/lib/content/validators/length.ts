import {
  getPlatformCharLimits,
  type ContentKind,
} from '@/lib/platform-config';

export interface ReplyLengthOptions {
  platform: string;
  kind: ContentKind;
}

export interface ReplyLengthResult {
  ok: boolean;
  /** Machine-readable reason code when `ok === false`. */
  reason?: 'too_long';
  /** Number of characters over the cap (0 when within the limit). */
  excess?: number;
  /** Resolved char limit for the platform + kind, returned for UI display. */
  limit: number;
  length: number;
}

/**
 * Validate that `text` fits inside the platform's cap for the given content
 * kind. Uses `getPlatformCharLimits` from the platform registry so adding a
 * new platform doesn't require editing validators.
 *
 * Uses Array.from to count grapheme-friendly code points rather than
 * `text.length` so emoji / astral characters aren't counted twice on X.
 */
export function validateReplyLength(
  text: string,
  { platform, kind }: ReplyLengthOptions,
): ReplyLengthResult {
  const limit = getPlatformCharLimits(platform, kind);
  const length = [...text].length;
  if (length > limit) {
    return { ok: false, reason: 'too_long', excess: length - limit, limit, length };
  }
  return { ok: true, limit, length };
}
