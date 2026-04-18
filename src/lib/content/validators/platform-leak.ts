import { PLATFORMS, getPlatformConfig } from '@/lib/platform-config';

export interface PlatformLeakOptions {
  targetPlatform: string;
}

export interface PlatformLeakResult {
  ok: boolean;
  /** The sibling platform names that appeared without a contrast marker. */
  leakedPlatforms: string[];
  /** Raw matched terms, for debugging / surfacing to the user. */
  matches: Array<{ term: string; platform: string; sentence: string }>;
}

/**
 * Contrast markers that signal a deliberate comparison — e.g. "unlike Reddit,
 * X rewards ...". We allow sibling-platform mentions when one of these
 * appears in the same sentence. Lowercased; matched case-insensitively.
 */
const CONTRAST_MARKERS = [
  'unlike',
  'vs',
  'vs.',
  'versus',
  'instead of',
  'rather than',
  'compared to',
  'compared with',
  'in contrast to',
  'over on',
  'as opposed to',
];

/**
 * Per-platform leak terms. These are the phrases a post for OTHER platforms
 * should not mention without a contrast marker. `displayName` itself is
 * handled separately so we don't hardcode "Reddit" / "X (Twitter)" here.
 *
 * Keep this map small and unambiguous — false positives are worse than the
 * occasional miss because the validator can hard-gate content.
 */
const PLATFORM_LEAK_TERMS: Record<string, string[]> = {
  reddit: ['reddit', 'r/', 'subreddit', 'upvote', 'upvoted', 'upvotes', 'karma'],
  x: ['twitter', 'x.com', 'retweet', 'retweeted', 'rt @', 'quote tweet', 'tweet', 'tweeted'],
};

/** Split text into naive sentences. Good enough for per-sentence contrast detection. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function containsTerm(sentence: string, term: string): boolean {
  const lower = sentence.toLowerCase();
  const t = term.toLowerCase();

  // Handle prefix-style tokens like "r/" and "rt @" with a substring match.
  if (/[^a-z0-9]/.test(t)) return lower.includes(t);

  // For word-shaped terms, require a word boundary so "tweet" doesn't match
  // "tweetable" and "rt" doesn't match "start".
  const re = new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
  return re.test(sentence);
}

function hasContrastMarker(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return CONTRAST_MARKERS.some((m) => lower.includes(m));
}

/**
 * Flag posts that name sibling platforms without an explicit contrast.
 * e.g. when targetPlatform="x", flag mentions of "reddit", "r/", "subreddit",
 * "upvote", "karma". Mentions inside a sentence containing a contrast marker
 * (`unlike`, `vs`, `instead of`, …) are allowed.
 *
 * Uses `PLATFORMS` registry so when a new platform lands, we only need to
 * extend `PLATFORM_LEAK_TERMS` with its vocabulary.
 */
export function validatePlatformLeak(
  text: string,
  { targetPlatform }: PlatformLeakOptions,
): PlatformLeakResult {
  // Throw on unknown target — callers should not be passing made-up ids.
  getPlatformConfig(targetPlatform);

  const siblings = Object.keys(PLATFORMS).filter((p) => p !== targetPlatform);
  const sentences = splitSentences(text);

  const matches: PlatformLeakResult['matches'] = [];
  const leakedPlatforms = new Set<string>();

  for (const sentence of sentences) {
    const contrast = hasContrastMarker(sentence);
    for (const sibling of siblings) {
      const terms = [
        ...(PLATFORM_LEAK_TERMS[sibling] ?? []),
        PLATFORMS[sibling].displayName.toLowerCase(),
      ];
      for (const term of terms) {
        if (!containsTerm(sentence, term)) continue;
        if (contrast) continue;
        matches.push({ term, platform: sibling, sentence });
        leakedPlatforms.add(sibling);
      }
    }
  }

  return {
    ok: matches.length === 0,
    leakedPlatforms: [...leakedPlatforms],
    matches,
  };
}
