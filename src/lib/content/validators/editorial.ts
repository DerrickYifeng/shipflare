/**
 * Editorial validators — ShipFlare's stylistic rules layered on top of what
 * the platform actually enforces. Surfaced as `severity: 'warning'` so an
 * agent can repair-or-ship rather than hard-block.
 *
 * Keep these intentionally narrow: a warning a writer would ignore in 80%+
 * of cases is just noise.
 */
import type { ContentKind } from '@/lib/platform-config';

const URL_RE = /\bhttps?:\/\/\S+/gi;
const HASHTAG_RE = /(?:^|\s)(#[\w][\w-]*)/g;

export interface HashtagCountResult {
  ok: boolean;
  count: number;
  hashtags: string[];
  /** Inclusive bounds for this (platform, kind). */
  min: number;
  max: number;
}

export interface LinksInReplyResult {
  ok: boolean;
  urls: string[];
}

export interface LinksInPostBodyResult {
  ok: boolean;
  urls: string[];
}

/**
 * Per-(platform, kind) hashtag bounds. ShipFlare style — not platform.
 *
 * X post: #buildinpublic + 1-2 from a curated set. ≤3 hashtags total.
 * X reply: zero hashtags (pattern-matches to bot energy in replies).
 * Reddit: subreddit-driven; we don't enforce, return ok=true and let prose
 *   handle subreddit-specific etiquette.
 */
const HASHTAG_BOUNDS: Record<string, Partial<Record<ContentKind, { min: number; max: number }>>> = {
  x: {
    post: { min: 0, max: 3 },
    reply: { min: 0, max: 0 },
  },
};

export function validateHashtagCount(
  text: string,
  platform: string,
  kind: ContentKind,
): HashtagCountResult {
  const matches: string[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) matches.push(m[1]);
  const bounds = HASHTAG_BOUNDS[platform]?.[kind];
  if (!bounds) {
    return { ok: true, count: matches.length, hashtags: matches, min: 0, max: Infinity };
  }
  const ok = matches.length >= bounds.min && matches.length <= bounds.max;
  return { ok, count: matches.length, hashtags: matches, min: bounds.min, max: bounds.max };
}

/**
 * X replies: links should never appear in the reply body. The platform
 * allows them (t.co'd to 23 chars), but they tank reach and read as drive-by.
 * ShipFlare style — not platform.
 */
export function validateLinksInReply(
  text: string,
  platform: string,
  kind: ContentKind,
): LinksInReplyResult {
  if (platform !== 'x' || kind !== 'reply') {
    return { ok: true, urls: [] };
  }
  const urls = text.match(URL_RE) ?? [];
  return { ok: urls.length === 0, urls };
}

/**
 * X posts: links inside the tweet body cost ~50% reach. Move them to the
 * first reply via the `linkReply` field. ShipFlare style — not platform.
 *
 * Only flags single-tweet posts. For threads (\n\n separator) the first-tweet
 * link rule still applies, but the existing tooling routes `linkReply`
 * separately, so we don't double-fire here.
 */
export function validateLinksInPostBody(
  text: string,
  platform: string,
  kind: ContentKind,
): LinksInPostBodyResult {
  if (platform !== 'x' || kind !== 'post') {
    return { ok: true, urls: [] };
  }
  const urls = text.match(URL_RE) ?? [];
  return { ok: urls.length === 0, urls };
}
