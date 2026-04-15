import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';

/**
 * Pain-point templates — how real users describe problems.
 */
const PAIN_TEMPLATES = [
  (kw: string) => `how to ${kw}`,
  (kw: string) => `${kw} not working`,
  (kw: string) => `need help with ${kw}`,
  (kw: string) => `can't ${kw}`,
] as const;

/**
 * X-specific pain templates — question-only format to filter out
 * thought leadership and promotional content on X/Twitter.
 */
const X_PAIN_TEMPLATES = [
  (kw: string) => `"how do I" ${kw}`,
  (kw: string) => `"need help" ${kw}`,
  (kw: string) => `"can't figure out" ${kw}`,
  (kw: string) => `"anyone know" ${kw}`,
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
 * X-specific solution-seeking templates — explicit question format.
 */
const X_SOLUTION_TEMPLATES = [
  (kw: string) => `"what tools" ${kw}`,
  (kw: string) => `"any recommendations" ${kw}`,
  (kw: string) => `"looking for" ${kw} tool`,
  (kw: string) => `"does anyone" ${kw}`,
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
 * Extract the core pain phrase from valueProp.
 * Strips action prefixes ("Automates", "Simplifies", etc.) and trailing
 * qualifier clauses ("with...", "across...", "that...") to get the
 * user-facing problem the product solves.
 *
 * Example: "Automates community discovery and engagement across platforms
 *           with AI-generated content" → "community discovery and engagement"
 */
function extractPainPhrase(valueProp: string): string {
  return valueProp
    .replace(
      /^(Automates?|Simplif(?:y|ies)|Streamlines?|Helps?(?: you)?(?: to)?|Enables?|Provides?|Offers?|Makes? (?:it )?(?:easy|simple|fast) to)\s+/i,
      '',
    )
    .split(/[.,;]|\s+(?:with|across|that|by|for|using|via|through|so)\s+/i)[0]!
    .trim()
    .toLowerCase()
    .slice(0, 60);
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
    customPainPhrases: z.array(z.string()).optional().describe('Per-user custom pain phrases to append'),
    customQueryTemplates: z.array(z.string()).optional().describe('Per-user custom query templates to append'),
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
    const painPhrase = extractPainPhrase(input.valueProp);

    const queries: string[] = [];

    // Pass 1: valueProp-derived pain query (targets the SPECIFIC problem)
    if (platform === 'reddit') {
      queries.push(quote(painPhrase));
    } else {
      queries.push(`${painPhrase} ${source}`);
    }

    // Pass 2: Pain-point question with keyword
    const painTemplates = platform === 'x' ? X_PAIN_TEMPLATES : PAIN_TEMPLATES;
    const painFn = hashSelect(painTemplates, `${seed}-pain`);
    queries.push(painFn(core));

    // Pass 3: Solution-seeking query
    const solTemplates = platform === 'x' ? X_SOLUTION_TEMPLATES : SOLUTION_TEMPLATES;
    const solFn1 = hashSelect(solTemplates, `${seed}-sol1`);
    queries.push(solFn1(core));

    // Pass 4: valueProp as user frustration
    if (platform === 'x') {
      queries.push(`"need help" ${painPhrase}`);
    } else {
      queries.push(`how to ${painPhrase}`);
    }

    // Pass 5: Keyword-based frustration
    if (platform === 'x') {
      queries.push(`"struggling with" ${secondary}`);
    } else {
      queries.push(`struggling with ${secondary}`);
    }

    // Pass 6: Platform-specific strategy
    const strategyFn = PASS6_STRATEGY[platform ?? 'reddit'] ?? PASS6_STRATEGY.generic;
    queries.push(strategyFn(core, secondary, source));

    // Append per-user custom queries
    for (const phrase of input.customPainPhrases ?? []) {
      queries.push(phrase);
    }
    for (const template of input.customQueryTemplates ?? []) {
      queries.push(template);
    }

    // Deduplicate while preserving order
    const unique = [...new Set(queries)];

    return { queries: unique };
  },
});
