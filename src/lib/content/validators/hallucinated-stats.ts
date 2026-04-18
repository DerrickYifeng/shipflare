export interface HallucinatedStatsResult {
  ok: boolean;
  /** The statistical claims that lack a citation. */
  flaggedClaims: string[];
}

/**
 * Matches "stat-shaped" substrings we want to audit for a citation:
 *   - percentages:        "40%", "12.5%"
 *   - x-multipliers:      "10x", "3.5x"
 *   - "over N"/"up to N": "over 100", "up to 500" (any number)
 *   - Numbers containing currency/unit prefixes: "$1.2m", "5k users"
 *
 * A number is *not* flagged when it has a citation nearby: "according to",
 * "per <source>", "source:", a URL, or a twitter handle mention. We also
 * ignore purely ordinal numbers and years (1900-2099).
 */
const STAT_PATTERN =
  /(\$?\d+(?:[.,]\d+)?\s?(?:%|x\b|k\b|m\b|b\b|bn\b))|(?:\bover\s+\d+(?:[.,]\d+)?\b)|(?:\bup\s+to\s+\d+(?:[.,]\d+)?\b)/gi;

const CITATION_PATTERNS: RegExp[] = [
  /\baccording to\b/i,
  /\bper\s+[A-Z@][\w.-]+/,
  /\bsource\s*:/i,
  /\bcited by\b/i,
  /\bfrom\s+(?:a|the)\s+\w+\s+(?:study|report|survey|paper)\b/i,
  /https?:\/\//i,
  /\[[^\]]+\]\(https?:\/\/[^)]+\)/i,
  /@\w{2,}/,
];

/** A year-like number (1900-2099) is almost never a stat we want to flag. */
function looksLikeYear(match: string): boolean {
  return /^\d{4}$/.test(match.trim()) && /^(19|20)\d{2}$/.test(match.trim());
}

function hasCitationNearby(text: string, matchIndex: number, matchLen: number): boolean {
  // Look at a window of ~120 chars on either side of the claim. That is wide
  // enough to cover "40% — according to Stripe (2024 report)" but narrow
  // enough that unrelated URLs later in the post don't launder every number.
  const start = Math.max(0, matchIndex - 120);
  const end = Math.min(text.length, matchIndex + matchLen + 120);
  const window = text.slice(start, end);
  return CITATION_PATTERNS.some((p) => p.test(window));
}

/**
 * Flag unsourced numeric claims. Returns `ok: false` if any stat-shaped
 * substring appears without a nearby citation phrase / URL / @handle.
 */
export function validateHallucinatedStats(text: string): HallucinatedStatsResult {
  const flaggedClaims: string[] = [];
  for (const m of text.matchAll(STAT_PATTERN)) {
    const raw = m[0];
    if (looksLikeYear(raw)) continue;
    if (hasCitationNearby(text, m.index ?? 0, raw.length)) continue;
    flaggedClaims.push(raw.trim());
  }
  return { ok: flaggedClaims.length === 0, flaggedClaims };
}
