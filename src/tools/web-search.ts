import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';

export const webSearchTool = buildTool({
  name: 'web_search',
  description:
    'Search the web via Google (Serper.dev). Use siteFilter for platform-specific searches on long-tail communities without dedicated tools (e.g. dev.to, community.hubspot.com).',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    siteFilter: z
      .string()
      .nullable()
      .optional()
      .describe('Restrict results to a specific domain (e.g. "dev.to")'),
    limit: z.number().min(1).max(20).default(10),
  }),
  async execute(input) {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      throw new Error('SERPER_API_KEY not configured');
    }

    const query = input.siteFilter
      ? `site:${input.siteFilter} ${input.query}`
      : input.query;

    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: input.limit,
      }),
    });

    if (!response.ok) {
      throw new Error(`Serper API: ${response.status}`);
    }

    const data = (await response.json()) as {
      organic: Array<{
        title: string;
        link: string;
        snippet: string;
        position: number;
        date?: string;
      }>;
    };

    return (data.organic ?? []).map((result) => ({
      title: result.title,
      url: result.link,
      snippet: result.snippet,
      position: result.position,
      date: result.date ?? null,
    }));
  },
});
