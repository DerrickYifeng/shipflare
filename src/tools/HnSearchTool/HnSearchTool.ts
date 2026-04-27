import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';

const HN_ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

export const hnSearchTool = buildTool({
  name: 'hn_search',
  description:
    'Search HackerNews stories and comments via Algolia. Free, no auth required. Filter by points, comments, date, and type (story/comment/ask_hn/show_hn).',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    tags: z
      .string()
      .nullable()
      .optional()
      .describe('Filter by type: "story", "comment", "ask_hn", "show_hn"'),
    minPoints: z.number().nullable().optional().describe('Minimum points filter'),
    minComments: z.number().nullable().optional().describe('Minimum comments filter'),
    afterDate: z
      .string()
      .nullable()
      .optional()
      .describe('ISO date — only results after this date'),
    limit: z.number().min(1).max(100).default(20),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('relevance')
      .describe('Sort by relevance or date'),
  }),
  async execute(input) {
    const endpoint =
      input.sortBy === 'date' ? 'search_by_date' : 'search';

    const params = new URLSearchParams({
      query: input.query,
      hitsPerPage: String(input.limit),
    });

    if (input.tags) {
      params.set('tags', input.tags);
    }

    // Build numeric filters
    const numericFilters: string[] = [];
    if (input.minPoints !== undefined) {
      numericFilters.push(`points>${input.minPoints}`);
    }
    if (input.minComments !== undefined) {
      numericFilters.push(`num_comments>${input.minComments}`);
    }
    if (input.afterDate) {
      const timestamp = Math.floor(new Date(input.afterDate).getTime() / 1000);
      numericFilters.push(`created_at_i>${timestamp}`);
    }
    if (numericFilters.length > 0) {
      params.set('numericFilters', numericFilters.join(','));
    }

    const response = await fetch(
      `${HN_ALGOLIA_BASE}/${endpoint}?${params.toString()}`,
      { headers: { 'User-Agent': 'ShipFlare/1.0.0' } },
    );

    if (!response.ok) {
      throw new Error(`HN Algolia API: ${response.status}`);
    }

    const data = (await response.json()) as {
      hits: Array<{
        objectID: string;
        title?: string;
        story_title?: string;
        url?: string;
        story_url?: string;
        author: string;
        points?: number;
        num_comments?: number;
        created_at_i: number;
        comment_text?: string;
        story_text?: string;
        _tags: string[];
      }>;
    };

    return data.hits.map((hit) => ({
      id: hit.objectID,
      title: hit.title ?? hit.story_title ?? '',
      url: hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      author: hit.author,
      points: hit.points ?? 0,
      commentCount: hit.num_comments ?? 0,
      createdUtc: hit.created_at_i,
      body: (hit.comment_text ?? hit.story_text ?? '').slice(0, 500),
      tags: hit._tags,
    }));
  },
});
