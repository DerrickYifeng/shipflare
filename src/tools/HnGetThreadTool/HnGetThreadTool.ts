import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';

const HN_ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

interface HNItem {
  id: number;
  title?: string;
  url?: string;
  author: string;
  text?: string;
  points?: number;
  created_at_i: number;
  children: HNItem[];
}

export const hnGetThreadTool = buildTool({
  name: 'hn_get_thread',
  description:
    'Get a HackerNews story with its full comment tree. Returns the story and all nested comments for deep analysis.',
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultSizeChars: 50_000,
  inputSchema: z.object({
    id: z.string().describe('HN item ID (numeric string)'),
  }),
  async execute(input) {
    const response = await fetch(
      `${HN_ALGOLIA_BASE}/items/${input.id}`,
      { headers: { 'User-Agent': 'ShipFlare/1.0.0' } },
    );

    if (!response.ok) {
      throw new Error(`HN Algolia items API: ${response.status}`);
    }

    const item = (await response.json()) as HNItem;

    const comments: Array<{
      id: number;
      author: string;
      text: string;
      createdUtc: number;
      depth: number;
    }> = [];

    function flatten(children: HNItem[], depth: number) {
      for (const child of children) {
        comments.push({
          id: child.id,
          author: child.author ?? '[deleted]',
          text: (child.text ?? '').slice(0, 1000),
          createdUtc: child.created_at_i ?? 0,
          depth,
        });
        if (child.children?.length > 0 && depth < 3) {
          flatten(child.children, depth + 1);
        }
      }
    }

    if (item.children) {
      flatten(item.children, 0);
    }

    return {
      id: item.id,
      title: item.title ?? '',
      url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
      hnUrl: `https://news.ycombinator.com/item?id=${item.id}`,
      author: item.author,
      body: (item.text ?? '').slice(0, 2000),
      points: item.points ?? 0,
      commentCount: comments.length,
      createdUtc: item.created_at_i,
      comments,
    };
  },
});
