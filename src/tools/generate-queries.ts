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
 */
const SOLUTION_TEMPLATES = [
  (kw: string) => `best ${kw} tool`,
  (kw: string) => `recommend ${kw}`,
  (kw: string) => `what do you use for ${kw}`,
  (kw: string) => `looking for ${kw} software`,
] as const;

/**
 * Deterministic seeded selection — picks a template variant based on
 * the subreddit + keyword combo so results are reproducible.
 */
function hashSelect<T>(items: readonly T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return items[Math.abs(hash) % items.length]!;
}

/**
 * Wrap multi-word keywords in quotes for exact-match Reddit search.
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

export const generateQueriesTool = buildTool({
  name: 'generate_queries',
  description:
    'Generate 6 targeted search queries for a subreddit using a 4-pass strategy: problem discovery, solution seeking, competitor intelligence, and workflow targeting. Queries stay tightly anchored to the product\'s core function.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    productName: z.string().describe('Product name'),
    productDescription: z.string().describe('What the product does'),
    keywords: z.array(z.string()).describe('Relevant keywords'),
    valueProp: z.string().describe('Core value proposition'),
    subreddit: z.string().describe('Subreddit name without r/ prefix'),
  }),
  async execute(input) {
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
    const seed = input.subreddit;

    const queries: string[] = [];

    // Pass 1: Problem discovery (2 queries)
    queries.push(quote(core));
    const painFn = hashSelect(PAIN_TEMPLATES, `${seed}-pain`);
    queries.push(painFn(core));

    // Pass 2: Solution seeking (2 queries)
    const solFn1 = hashSelect(SOLUTION_TEMPLATES, `${seed}-sol1`);
    queries.push(solFn1(core));
    const solFn2 = hashSelect(SOLUTION_TEMPLATES, `${seed}-sol2`);
    queries.push(solFn2(secondary));

    // Pass 3: Competitor intelligence (1 query)
    queries.push(`${quote(core)} alternative`);

    // Pass 4: Workflow targeting with Reddit operators (1 query)
    // Use the most specific single noun from the core keyword for title search
    const titleWord = core.split(' ').reduce((a, b) => (a.length >= b.length ? a : b));
    queries.push(`title:"${titleWord}" self:true`);

    // Deduplicate while preserving order
    const unique = [...new Set(queries)];

    return { queries: unique };
  },
});
