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

/**
 * Humility tells — surface AI-sermon patterns that make the founder sound
 * like a thought-leader they haven't earned to be yet. Three pattern
 * families, each carrying its own repair hint:
 *
 *   • corrective-opener — "the real X is Y" / "isn't X. it's Y" /
 *     "isn't X — it's Y" — the writer pretends to correct the reader's
 *     framing, lands as preachy.
 *   • coach-voice — "Winners do X" / "Most solo devs Y" / "Top 1%" /
 *     "the pros" — generalizes from authority the writer may not have.
 *   • imperative-prescription — "Pick 1" / "You need 1 metric" /
 *     "Measure something" / "Just ship more" — bossy advice on a thread
 *     where the OP didn't ask.
 *
 * ShipFlare style — surfaced as warnings so callers can repair-or-ship
 * (with `whyItWorks` justification) rather than hard-block.
 */
const HUMILITY_TELL_PATTERNS: Array<{
  name: HumilityTellPatternName;
  re: RegExp;
  hint: string;
}> = [
  {
    name: 'corrective-opener',
    // Two alternation arms:
    //   1. "the real <noun> is/isn't ..."
    //   2. "<X> isn't|not just|is not just <Y> [.—] <pronoun-of-contrast>"
    // The em-dash variant tolerates 0 surrounding spaces (`skills—it's`) since
    // that's the live drafts' style; period variant still requires `\s+`.
    re: /(?:\bthe real \w+ (?:is|isn'?t)\b|\b(?:isn'?t|is not (?:just|merely)|are not (?:just|merely)|not just|not merely) [\w\s'-]{1,40}\s*(?:\.\s+|\s*—\s*)(?:it'?s|that'?s|we'?re|you'?re|i'?m)\b)/i,
    hint: 'corrective-opener pattern ("the real X is Y" / "isn\'t X — it\'s Y" / "not just X — you\'re Y") reads as AI sermon. Lead with what you actually saw or did, not what\'s "really" true.',
  },
  {
    name: 'coach-voice',
    re: /\b(?:winners (?:do|are|aren'?t|don'?t|post|build|ship|never|always)\b|most (?:solo )?(?:devs|founders|builders|people) (?:don'?t|aren'?t|are|do|need|just)\b|top \d+%\b|the pros\b)/i,
    hint: '"Winners do X" / "Most solo devs Y" generalizes from authority you may not have. Replace with what you/your team specifically did, or ask a specific question instead.',
  },
  {
    name: 'imperative-prescription',
    re: /\b(?:you need (?:to )?\d+|pick (?:1|one)\b|measure something\b|just (?:ship|do|build|post|measure) more\b)/i,
    hint: 'imperative prescription ("Pick 1" / "Measure something" / "You need 1 metric") on a thread where the OP didn\'t ask reads bossy. Soften to "we tried X" or ask the OP what they\'ve already tried.',
  },
];

export type HumilityTellPatternName =
  | 'corrective-opener'
  | 'coach-voice'
  | 'imperative-prescription';

export interface HumilityTellHit {
  pattern: HumilityTellPatternName;
  match: string;
  hint: string;
}

export interface HumilityTellsResult {
  ok: boolean;
  hits: HumilityTellHit[];
}

export function validateHumilityTells(text: string): HumilityTellsResult {
  const hits: HumilityTellHit[] = [];
  for (const p of HUMILITY_TELL_PATTERNS) {
    const m = text.match(p.re);
    if (m) hits.push({ pattern: p.name, match: m[0], hint: p.hint });
  }
  return { ok: hits.length === 0, hits };
}
