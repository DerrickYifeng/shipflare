// web_search — Anthropic-native web search via the SDK's server-tool.
//
// Mirrors engine/tools/WebSearchTool/WebSearchTool.ts. Spins up an
// internal sub-conversation with `tools: [{type: 'web_search_20250305',
// max_uses: 8, ...}]` attached. Anthropic's API performs the actual
// searching server-side; we accumulate the response content blocks
// into { query, results, durationSeconds } and return.
//
// Decision-to-call is description-driven (engine pattern) — no
// mechanical gate. The prompt below describes when the tool's useful
// and lets the calling skill / agent decide.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:web-search');

export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const webSearchInputSchema = z
  .object({
    query: z.string().min(2),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
  })
  .strict()
  .refine(
    (v) => !(v.allowed_domains?.length && v.blocked_domains?.length),
    {
      message: 'allowed_domains and blocked_domains are mutually exclusive',
    },
  );

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface WebSearchHit {
  title: string;
  url: string;
}

export interface WebSearchResultBlock {
  tool_use_id: string;
  content: WebSearchHit[];
}

export interface WebSearchOutput {
  query: string;
  results: Array<WebSearchResultBlock | string>;
  durationSeconds: number;
}

const SYSTEM_PROMPT = 'You are an assistant for performing a web search tool use';

const TOOL_DESCRIPTION = `
- Searches the web and returns up to 10 result links per call
- Use this when you need real-world data beyond your training cutoff:
  industry benchmarks, recent product launches, competitor numbers,
  current market signals
- Especially useful when setting numeric milestones — search for typical
  baselines in this product's category and stage before writing a target
- Returns title + URL for each hit. Use web_fetch to read a specific result
- Up to 8 server-side searches per call; cite sources in your output
- Use the current year in queries when looking for recent data
`.trim();

export const webSearchTool: ToolDefinition<WebSearchInput, WebSearchOutput> =
  buildTool({
    name: WEB_SEARCH_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: webSearchInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input): Promise<WebSearchOutput> {
      const start = performance.now();
      const client = new Anthropic();

      // Anthropic's web_search server-tool. Type comes from the
      // standard messages namespace (WebSearchTool20250305) — it's no
      // longer Beta-only. We construct the tool config explicitly so
      // every field's typed at the call site.
      const webSearchToolConfig: Anthropic.Messages.WebSearchTool20250305 = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 8,
        ...(input.allowed_domains?.length
          ? { allowed_domains: input.allowed_domains }
          : {}),
        ...(input.blocked_domains?.length
          ? { blocked_domains: input.blocked_domains }
          : {}),
      };

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Perform a web search for the query: ${input.query}`,
          },
        ],
        tools: [webSearchToolConfig],
      });

      const results: Array<WebSearchResultBlock | string> = [];
      let textAcc = '';
      let inText = true;

      // Engine pattern: blocks come in roughly the sequence
      // [text]?, (server_tool_use, web_search_tool_result, [text|citation]+)+
      // Walk linearly, buffering contiguous text into one chunk and
      // pushing each web_search_tool_result as a structured entry.
      // The SDK's ContentBlock union is wider than what we actually
      // care about here (it includes container upload, code execution,
      // etc.) — narrow via `unknown` so TS lets us index by `type`.
      const blocks = ((response.content ?? []) as unknown) as Array<{
        type: string;
        [k: string]: unknown;
      }>;

      for (const block of blocks) {
        if (block.type === 'server_tool_use') {
          if (inText) {
            inText = false;
            if (textAcc.trim().length > 0) results.push(textAcc.trim());
            textAcc = '';
          }
          continue;
        }

        if (block.type === 'web_search_tool_result') {
          const content = block.content;
          if (!Array.isArray(content)) {
            const errorCode =
              (content as { error_code?: string } | undefined)?.error_code ??
              'unknown';
            results.push(`Web search error: ${errorCode}`);
            continue;
          }
          results.push({
            tool_use_id: String(block.tool_use_id),
            content: (content as Array<{ title: string; url: string }>).map(
              (r) => ({ title: r.title, url: r.url }),
            ),
          });
          continue;
        }

        if (block.type === 'text') {
          if (inText) {
            textAcc += String(block.text ?? '');
          } else {
            inText = true;
            textAcc = String(block.text ?? '');
          }
        }
      }

      if (textAcc.length > 0) results.push(textAcc.trim());

      const durationSeconds = (performance.now() - start) / 1000;
      log.info(
        `web_search query="${input.query.slice(0, 80)}" ` +
          `results=${results.length} duration=${durationSeconds.toFixed(2)}s`,
      );
      return { query: input.query, results, durationSeconds };
    },
  });
