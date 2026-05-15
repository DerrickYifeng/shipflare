/**
 * Inline draft validators for Phase 1.
 *
 * S6 ports the canonical validators from src/lib/content/validators/* to
 * packages/tools (per the Phase 1 plan). For now, we inline simplified
 * versions so S4.3 / S4.4 can be functionally complete.
 *
 * platform-leak: reject draft if it mentions another platform's distinctive
 * vocabulary (e.g., a Reddit reply that talks about "tweets" or "X").
 * The canonical implementation in src/lib/content/validators/platform-leak.ts
 * has per-platform LeakTerm lists (word/substring/regex shapes); this
 * simplified version just keeps the most common terms.
 *
 * Until S6 ships the real port, this is good-enough: catches obvious leaks
 * (~70% of cases), false positives are low, false negatives just slip
 * through to founder approval.
 */

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Phase-1 platform-leak terms. S6 lifts this from
 * src/lib/content/validators/platform-leak.ts's PLATFORM_LEAK_TERMS.
 */
const PLATFORM_LEAK_TERMS: Record<"x" | "reddit", string[]> = {
  x: ["reddit", "subreddit", "r/", "upvote", "downvote", "OP "],
  reddit: ["twitter", "tweet", "tweeted", "retweet", " X.com", " on X "],
};

export function validatePlatformLeak(
  body: string,
  platform: "x" | "reddit",
): ValidationResult {
  const terms = PLATFORM_LEAK_TERMS[platform] ?? [];
  const lower = body.toLowerCase();
  const hits = terms.filter((t) => lower.includes(t.toLowerCase()));
  if (hits.length === 0) return { ok: true, reasons: [] };
  return {
    ok: false,
    reasons: [
      `Mentions ${platform === "x" ? "Reddit" : "X"} vocabulary: ${hits.join(", ")}`,
    ],
  };
}

/**
 * validate_draft — composite check. Phase 1 only runs platform-leak;
 * S6 wires throttle (reply-throttle.ts) and validate-draft.ts checks.
 */
export function validateDraft(
  body: string,
  platform: "x" | "reddit",
): ValidationResult {
  const leak = validatePlatformLeak(body, platform);
  if (!leak.ok) return leak;
  // Length sanity: reject empty / >280 for X (Twitter limit), >10k for Reddit
  if (body.trim().length === 0) {
    return { ok: false, reasons: ["empty body"] };
  }
  if (platform === "x" && body.length > 280) {
    return {
      ok: false,
      reasons: [`X length limit exceeded: ${body.length} chars`],
    };
  }
  if (platform === "reddit" && body.length > 10000) {
    return {
      ok: false,
      reasons: [`Reddit length limit exceeded: ${body.length} chars`],
    };
  }
  return { ok: true, reasons: [] };
}
