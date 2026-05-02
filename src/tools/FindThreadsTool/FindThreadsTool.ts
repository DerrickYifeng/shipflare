// find_threads — query the discovered-threads inbox for engagement
// candidates.
//
// Called by: content-manager (during a reply sweep). Reads from the
// `threads` table — the discovery pipeline (reply-guy discovery worker)
// fills that table; this tool just filters, ranks, and returns.
//
// Scoping: every query is bound to `userId` — an agent run cannot see
// another founder's inbox.
//
// Platform filter: the tool takes a `platforms` array; threads whose
// `platform` column isn't in that array are excluded. If the array is
// omitted, every connected platform is returned. This mirrors the
// "platform-aware routing" rule from CLAUDE.md.
//
// The tool returns a compact summary, not the full thread body — the
// agent can fetch the full body later via platform-specific tools
// (x_get_tweet) when it actually decides to draft.

import { z } from 'zod';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { threads } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const FIND_THREADS_TOOL_NAME = 'find_threads';

const DEFAULT_WINDOW_MINUTES = 1440; // 24h — matches reddit replyWindowMinutes
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const findThreadsInputSchema = z
  .object({
    platforms: z.array(z.string().min(1)).optional(),
    windowMinutes: z.number().int().positive().max(10_080).optional(), // 7d max
    minRelevance: z.number().min(0).max(1).optional(),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .strict();

export type FindThreadsInput = z.infer<typeof findThreadsInputSchema>;

export interface ThreadRow {
  threadId: string;
  platform: string;
  community: string;
  title: string;
  body: string | null;
  author: string | null;
  url: string;
  upvotes: number | null;
  commentCount: number | null;
  /** 0..1 — scout agent's confidence in this thread. Null for legacy rows. */
  scoutConfidence: number | null;
  postedAt: string | null;
  discoveredAt: string;
}

export const findThreadsTool: ToolDefinition<FindThreadsInput, { threads: ThreadRow[] }> =
  buildTool({
    name: FIND_THREADS_TOOL_NAME,
    description:
      'Query the discovered-threads inbox for engagement candidates. Pass ' +
      '`platforms` to filter (defaults to every connected channel), ' +
      '`windowMinutes` to cap recency (default 24h), `minRelevance` to ' +
      'drop low-signal threads (0-1 scale, default 0), and `limit` to ' +
      'cap returned rows (default 20, max 100). Returns a compact summary ' +
      'per thread; fetch full bodies with platform-specific tools if ' +
      'needed before drafting.' +
      '\n\n' +
      'INPUT SHAPE (`platforms` MUST be an array of strings, NOT a single string):\n' +
      '{ "platforms": ["x", "reddit"], "windowMinutes": 1440, "minRelevance": 0.4, "limit": 20 }\n\n' +
      'To filter a single platform: `"platforms": ["x"]` (still wrap it in an array). ' +
      'Omit `platforms` entirely to return threads from all connected channels.',
    inputSchema: findThreadsInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, ctx): Promise<{ threads: ThreadRow[] }> {
      const { db, userId } = readDomainDeps(ctx);

      const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
      const cutoff = new Date(Date.now() - windowMinutes * 60_000);
      const limit = input.limit ?? DEFAULT_LIMIT;
      const minRelevance = input.minRelevance ?? 0;

      const filters = [
        eq(threads.userId, userId),
        gte(threads.discoveredAt, cutoff),
      ];
      if (input.platforms && input.platforms.length > 0) {
        filters.push(inArray(threads.platform, input.platforms));
      }

      const rows = await db
        .select({
          id: threads.id,
          platform: threads.platform,
          community: threads.community,
          title: threads.title,
          body: threads.body,
          author: threads.author,
          url: threads.url,
          upvotes: threads.upvotes,
          commentCount: threads.commentCount,
          scoutConfidence: threads.scoutConfidence,
          postedAt: threads.postedAt,
          discoveredAt: threads.discoveredAt,
        })
        .from(threads)
        .where(and(...filters))
        .orderBy(desc(threads.scoutConfidence), desc(threads.discoveredAt))
        .limit(limit * 2); // over-fetch so we can filter client-side

      const kept = rows
        .filter((r) => (r.scoutConfidence ?? 0) >= minRelevance)
        .slice(0, limit);

      const out: ThreadRow[] = kept.map((r) => ({
        threadId: r.id,
        platform: r.platform,
        community: r.community,
        title: r.title,
        body: r.body,
        author: r.author,
        url: r.url,
        upvotes: r.upvotes,
        commentCount: r.commentCount,
        scoutConfidence: r.scoutConfidence,
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        discoveredAt: r.discoveredAt.toISOString(),
      }));

      return { threads: out };
    },
  });
