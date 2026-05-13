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
 * A single leak-detection rule. Every term declares its match shape so a
 * substring fallback never silently catches benign English (e.g. `'r/'`
 * matching `color/style`, or `'rt @'` matching `smart @joe`).
 *
 * - `word` — case-insensitive, word-bounded (`\bvalue\b`). Use for normal
 *   English tokens like `tweet`, `karma`, `subreddit`.
 * - `substring` — case-insensitive `.includes()`. Reserve for multi-word
 *   phrases where word boundaries don't help (`quote tweet`, `x.com`).
 * - `regex` — bring-your-own RegExp. Required when the term needs custom
 *   anchoring (`/\br\/\w/i` so `r/` only fires when followed by a real
 *   subreddit name, not inside `color/style`). MUST carry a `label` —
 *   surfaced verbatim in `matches[].term` for debugging.
 */
type LeakTerm =
  | { kind: 'word'; value: string }
  | { kind: 'substring'; value: string }
  | { kind: 'regex'; value: RegExp; label: string };

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
 * Per-platform leak terms. Every platform MUST enumerate its vocabulary
 * explicitly — there is no silent `displayName` fallback. When adding a
 * new platform, add an entry here AND add a checklist item to the New
 * Platform Checklist in CLAUDE.md; missing entries mean drafts for that
 * platform won't be checked against sibling leaks.
 *
 * Keep this map small and unambiguous — false positives are worse than
 * the occasional miss because the validator can hard-gate content.
 */
const PLATFORM_LEAK_TERMS: Record<string, LeakTerm[]> = {
  reddit: [
    { kind: 'word', value: 'reddit' },
    // Match `r/<word>` (subreddit prefix) but NOT bare `/` after any word
    // ending in `r` (e.g. `color/style`, `year/year`, `our/your`).
    { kind: 'regex', value: /\br\/\w/i, label: 'r/' },
    { kind: 'word', value: 'subreddit' },
    { kind: 'word', value: 'upvote' },
    { kind: 'word', value: 'upvoted' },
    { kind: 'word', value: 'upvotes' },
    { kind: 'word', value: 'karma' },
  ],
  x: [
    { kind: 'word', value: 'twitter' },
    { kind: 'substring', value: 'x.com' },
    { kind: 'word', value: 'retweet' },
    { kind: 'word', value: 'retweeted' },
    // Match `RT @<handle>` (literal retweet token) but NOT any word ending
    // in `rt` followed by `@` (e.g. `smart @joe`, `start @noon`).
    { kind: 'regex', value: /\brt\s+@\w/i, label: 'rt @' },
    { kind: 'substring', value: 'quote tweet' },
    { kind: 'word', value: 'tweet' },
    { kind: 'word', value: 'tweeted' },
  ],
};

/** Split text into naive sentences. Good enough for per-sentence contrast detection. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function termMatches(sentence: string, term: LeakTerm): boolean {
  switch (term.kind) {
    case 'substring':
      return sentence.toLowerCase().includes(term.value.toLowerCase());
    case 'word': {
      const re = new RegExp(`\\b${escapeRegex(term.value)}\\b`, 'i');
      return re.test(sentence);
    }
    case 'regex':
      return term.value.test(sentence);
  }
}

function termLabel(term: LeakTerm): string {
  return term.kind === 'regex' ? term.label : term.value;
}

function hasContrastMarker(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return CONTRAST_MARKERS.some((m) => lower.includes(m));
}

/**
 * Flag posts that name sibling platforms without an explicit contrast.
 * e.g. when targetPlatform="x", flag mentions of "reddit", "r/<sub>",
 * "subreddit", "upvote", "karma". Mentions inside a sentence containing
 * a contrast marker (`unlike`, `vs`, `instead of`, …) are allowed.
 *
 * Every term in `PLATFORM_LEAK_TERMS` declares its match shape (word /
 * substring / regex). Substring is reserved for multi-word phrases —
 * single-token sibling vocab uses `word` so `tweet` doesn't match
 * `tweetable` and `r/` doesn't match `color/style`.
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
      const terms = PLATFORM_LEAK_TERMS[sibling] ?? [];
      for (const term of terms) {
        if (!termMatches(sentence, term)) continue;
        if (contrast) continue;
        matches.push({ term: termLabel(term), platform: sibling, sentence });
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
