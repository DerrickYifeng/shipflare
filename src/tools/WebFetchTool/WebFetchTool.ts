// web_fetch — fetch a URL and return the page as markdown.
//
// Thin wrapper around scrapeWebsite() in src/services/web-scraper.ts
// (port of engine/tools/WebFetchTool/utils.ts). All SSRF defenses,
// same-origin redirect handling, timeout, body cap, and Turndown
// conversion live there. This tool just exposes that service to the
// LLM as a registered tool with a stable input/output shape.
//
// No Haiku extraction layer — engine WebFetch passes the markdown +
// prompt to a small fast model; we return the raw markdown and let
// the calling skill / agent extract whatever it needs in its own turn.
// Saves a Haiku call per fetch; trades context budget for control.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { scrapeWebsite, type WebScrapeResult } from '@/services/web-scraper';

const log = createLogger('tool:web-fetch');

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

export const webFetchInputSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export interface WebFetchOutput {
  url: string;
  status: WebScrapeResult['status'];
  code: number;
  bytes: number;
  pageMarkdown: string;
  title: string;
  description: string;
  ogImage: string | null;
  redirectUrl?: string;
  error?: string;
  durationMs: number;
}

const TOOL_DESCRIPTION = `
- Fetches a URL and returns the page content as markdown
- Use to deeply read a specific page (e.g. a result from web_search)
- Markdown is capped at ~100K chars; large pages are truncated
- HTTP is auto-upgraded to HTTPS; redirects only follow same-origin
- If status is 'redirect', the page redirected cross-origin — call web_fetch
  again with the redirectUrl to follow
- Be selective: each fetch consumes context. Prefer searching first to
  identify the right URL, then fetching once
`.trim();

function statusToHttpCode(status: WebScrapeResult['status']): number {
  switch (status) {
    case 'success':
      return 200;
    case 'thin_content':
      return 200;
    case 'redirect':
      return 301;
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'error':
      return 0;
  }
}

export const webFetchTool: ToolDefinition<WebFetchInput, WebFetchOutput> = buildTool({
  name: WEB_FETCH_TOOL_NAME,
  description: TOOL_DESCRIPTION,
  inputSchema: webFetchInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input): Promise<WebFetchOutput> {
    const start = performance.now();
    const result = await scrapeWebsite(input.url);
    const durationMs = performance.now() - start;
    const out: WebFetchOutput = {
      url: result.url,
      status: result.status,
      code: statusToHttpCode(result.status),
      bytes: result.pageMarkdown.length,
      pageMarkdown: result.pageMarkdown,
      title: result.title,
      description: result.description,
      ogImage: result.ogImage,
      redirectUrl: result.redirectUrl,
      error: result.error,
      durationMs,
    };
    log.info(
      `web_fetch url=${input.url} status=${result.status} bytes=${out.bytes} duration=${durationMs.toFixed(0)}ms`,
    );
    return out;
  },
});
