import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';

/**
 * Pain-point templates — how real users describe problems on Reddit.
 */
const PAIN_TEMPLATES = [
  (kw: string) => `how to ${kw}`,
  (kw: string) => `${kw} not working`,
  (kw: string) => `need help with ${kw}`,
  (kw: string) => `can't ${kw}`,
] as const;

/**
 * Solution-seeking templates — users actively looking for tools.
 * Phrased as questions real users ask (not how marketers/competitors post).
 */
const SOLUTION_TEMPLATES = [
  (kw: string) => `what do you use for ${kw}`,
  (kw: string) => `how do you handle ${kw}`,
  (kw: string) => `recommend ${kw}`,
  (kw: string) => `struggling with ${kw}`,
] as const;

/**
 * Deterministic seeded selection — picks a template variant based on
 * the source + keyword combo so results are reproducible.
 */
function hashSelect<T>(items: readonly T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return items[Math.abs(hash) % items.length]!;
}

/**
 * Wrap multi-word keywords in quotes for exact-match search.
 */
function quote(kw: string): string {
  return kw.includes(' ') ? `"${kw}"` : kw;
}

/**
 * Pick the "core function" keyword — the shortest multi-word keyword,
 * or the first keyword if all are single-word.
 */
function pickCoreKeyword(keywords: string[]): string {
  const multiWord = keywords.filter((kw) => kw.includes(' '));
  if (multiWord.length > 0) {
    return multiWord.reduce((a, b) => (a.length <= b.length ? a : b));
  }
  return keywords[0] ?? '';
}

/**
 * Platform-specific strategy for the 6th query slot.
 * Each platform gets a query style that matches its search semantics.
 */
const PASS6_STRATEGY: Record<string, (core: string, secondary: string, source: string) => string> = {
  reddit: (core) => {
    const titleWord = core.split(' ').reduce((a, b) => (a.length >= b.length ? a : b));
    return `title:"${titleWord}" self:true`;
  },
  x: (_core, _secondary, source) => `how do I grow my ${source.toLowerCase()} no budget`,
  hn: (core) => `Ask HN: ${core}`,
  generic: (core, secondary) => `${core} ${secondary}`,
};

export const generateQueriesTool = buildTool({
  name: 'generate_queries',
  description:
    'Generate 6 targeted search queries using a 4-pass strategy: problem discovery, solution seeking, competitor intelligence, and workflow targeting. Queries stay tightly anchored to the product\'s core function. Works for any platform.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    productName: z.string().describe('Product name'),
    productDescription: z.string().describe('What the product does'),
    keywords: z.array(z.string()).describe('Relevant keywords'),
    valueProp: z.string().describe('Core value proposition'),
    source: z.string().nullable().optional().describe('Source name (subreddit, topic, etc.)'),
    // Backward compat: accept "subreddit" as alias for "source"
    subreddit: z.string().nullable().optional().describe('Deprecated alias for source (Reddit subreddit)'),
    topic: z.string().nullable().optional().describe('Deprecated alias for source (X/Twitter topic)'),
    platform: z.enum(['reddit', 'x', 'hn', 'generic']).optional().default('reddit').describe('Target platform'),
  }),
  async execute(input) {
    const platform = input.platform ?? 'reddit';
    // Resolve source: prefer explicit "source", fall back to "subreddit" or "topic"
    const source = input.source ?? input.subreddit ?? input.topic ?? '';

    // Filter keywords: remove product name, very short words, deduplicate
    const filtered = input.keywords
      .map((kw) => kw.toLowerCase().trim())
      .filter((kw) => kw.length > 3 && kw !== input.productName.toLowerCase())
      .filter((kw, i, arr) => arr.indexOf(kw) === i)
      .slice(0, 5);

    // If no usable keywords, fall back to valueProp words
    if (filtered.length === 0) {
      const vpWords = input.valueProp
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4);
      filtered.push(...vpWords.slice(0, 3));
    }

    const core = pickCoreKeyword(filtered);
    const secondary = filtered.find((kw) => kw !== core) ?? core;
    const seed = source;

    const queries: string[] = [];

    if (platform === 'reddit') {
      // Reddit: use Reddit-specific operators
      queries.push(quote(core));
    } else {
      // Other platforms: natural language queries with source context
      queries.push(`${core} ${source}`);
    }

    // Pass 2: Pain-point query
    const painFn = hashSelect(PAIN_TEMPLATES, `${seed}-pain`);
    queries.push(painFn(core));

    // Pass 3-4: Solution-seeking queries
    const solFn1 = hashSelect(SOLUTION_TEMPLATES, `${seed}-sol1`);
    queries.push(solFn1(core));
    const solFn2 = hashSelect(SOLUTION_TEMPLATES, `${seed}-sol2`);
    queries.push(solFn2(secondary));

    // Pass 5: Frustration / manual-process pain
    queries.push(`tired of manual ${core}`);

    // Pass 6: Platform-specific strategy
    const strategyFn = PASS6_STRATEGY[platform ?? 'reddit'] ?? PASS6_STRATEGY.generic;
    queries.push(strategyFn(core, secondary, source));

    // Deduplicate while preserving order
    const unique = [...new Set(queries)];

    return { queries: unique };
  },
});
