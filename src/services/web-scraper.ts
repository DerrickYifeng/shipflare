import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@/lib/logger';
import type { ProductAnalysis } from '@/types/code-scanner';

const log = createLogger('service:web-scraper');

export interface WebScrapeResult {
  url: string;
  pageMarkdown: string;
  title: string;
  description: string;
  ogImage: string | null;
  status:
    | 'success'
    | 'error'
    | 'thin_content'
    | 'not_found'
    | 'forbidden'
    | 'redirect';
  error?: string;
  redirectUrl?: string;
}

const MAX_MARKDOWN_CHARS = 100_000;
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const MAX_URL_LENGTH = 2000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ShipFlare/1.0; +https://shipflare.dev)';

/**
 * Reject pathological URLs before issuing any network call.
 * Mirrors engine/tools/WebFetchTool/utils.ts:validateURL.
 */
function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  // Block non-public hostnames (single-label, e.g. "localhost", "intranet").
  const parts = parsed.hostname.split('.');
  if (parts.length < 2) return false;
  return true;
}

/**
 * Permit a redirect only when same origin (with/without leading "www.").
 * Cross-origin redirects bubble up so the caller can re-issue with the
 * resolved URL — defends against expired-domain squatters and open-redirect
 * abuse. Mirrors engine isPermittedRedirect.
 */
function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const a = new URL(originalUrl);
    const b = new URL(redirectUrl);
    if (a.protocol !== b.protocol) return false;
    if (a.port !== b.port) return false;
    if (b.username || b.password) return false;
    const stripWww = (h: string) => h.replace(/^www\./, '');
    return stripWww(a.hostname) === stripWww(b.hostname);
  } catch {
    return false;
  }
}

type RedirectMarker = {
  type: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
};

/**
 * Manual redirect loop. Native fetch's `redirect: 'follow'` happily chains
 * across domains; that's how scrapers end up parked-domain content. Loop
 * with `redirect: 'manual'` and consult isPermittedRedirect on every hop.
 */
async function fetchWithSafeRedirects(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<Response | RedirectMarker> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
  }
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/markdown, text/html, */*',
    },
    redirect: 'manual',
    signal,
  });
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect missing Location header');
    const redirectUrl = new URL(location, url).toString();
    if (isPermittedRedirect(url, redirectUrl)) {
      return fetchWithSafeRedirects(redirectUrl, signal, depth + 1);
    }
    return {
      type: 'redirect',
      originalUrl: url,
      redirectUrl,
      statusCode: response.status,
    };
  }
  return response;
}

function isRedirectMarker(
  v: Response | RedirectMarker,
): v is RedirectMarker {
  return 'type' in v && v.type === 'redirect';
}

/**
 * Scrape a website and convert to markdown for AI analysis.
 * Adapted from engine/tools/WebFetchTool — Turndown full-page conversion,
 * same-origin-only redirect handling, content size + timeout caps.
 */
export async function scrapeWebsite(url: string): Promise<WebScrapeResult> {
  if (!validateURL(url)) {
    return emptyResult(url, 'error', 'Invalid URL');
  }

  // Upgrade http→https (engine pattern; many sites 301 anyway).
  let fetchUrl = url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
      fetchUrl = parsed.toString();
    }
  } catch {
    return emptyResult(url, 'error', 'Invalid URL');
  }

  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetchWithSafeRedirects(fetchUrl, signal);

    if (isRedirectMarker(response)) {
      return {
        ...emptyResult(url, 'redirect', `Redirects to ${response.redirectUrl}`),
        redirectUrl: response.redirectUrl,
      };
    }

    if (response.status === 404) {
      return emptyResult(url, 'not_found', 'Page not found (404)');
    }
    if (response.status === 403) {
      return emptyResult(url, 'forbidden', 'Access denied (403)');
    }
    if (!response.ok) {
      return emptyResult(url, 'error', `HTTP ${response.status}`);
    }

    // Reject oversize responses up front when the server discloses Content-Length.
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_HTTP_CONTENT_LENGTH) {
      return emptyResult(
        url,
        'error',
        `Response too large (${contentLength} bytes > ${MAX_HTTP_CONTENT_LENGTH})`,
      );
    }

    const html = await response.text();
    if (html.length > MAX_HTTP_CONTENT_LENGTH) {
      return emptyResult(url, 'error', 'Response body exceeds size cap');
    }

    const $ = cheerio.load(html);

    // Strip noise that bloats markdown without adding semantic value:
    // inline JS, stylesheets, and the noscript fallback marketing copy.
    // Done before metadata read so any of these living next to <meta>
    // tags can't slip in via Turndown either.
    $('script, style, noscript').remove();

    // Extract structured metadata via cheerio (for ogImage, favicon, etc.)
    const title =
      $('meta[property="og:title"]').attr('content') ??
      $('title').text().trim() ??
      '';

    const description =
      $('meta[property="og:description"]').attr('content') ??
      $('meta[name="description"]').attr('content') ??
      '';

    const ogImage =
      $('meta[property="og:image"]').attr('content') ?? null;

    // Check for thin content
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    if (bodyText.length < 100) {
      return {
        url,
        pageMarkdown: bodyText,
        title,
        description,
        ogImage,
        status: 'thin_content',
        error: 'Page has very little text content',
      };
    }

    // Turndown: convert cleaned HTML → markdown (script/style/noscript removed).
    const TurndownService = (await import('turndown')).default;
    const turndown = new TurndownService();
    const pageMarkdown = turndown.turndown($.html()).slice(0, MAX_MARKDOWN_CHARS);

    return { url, pageMarkdown, title, description, ogImage, status: 'success' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`scrapeWebsite failed for ${url}: ${message}`);
    return emptyResult(url, 'error', message);
  }
}

function emptyResult(
  url: string,
  status: WebScrapeResult['status'],
  error: string,
): WebScrapeResult {
  return {
    url,
    pageMarkdown: '',
    title: '',
    description: '',
    ogImage: null,
    status,
    error,
  };
}

const ANALYZE_PROMPT = `You analyze websites to understand what product or service they offer.
Given the page content below, extract:

1. productName — the actual product/brand name (not the domain)
2. oneLiner — one sentence describing what it does, in plain language
3. targetAudience — who this product is for (be specific: "indie developers", "small business owners", etc.)
4. keywords — 5-8 topic keywords a potential user would search for (lowercase, no brand names)
5. valueProp — the core value proposition in one sentence

Respond with ONLY a JSON object matching this shape:
{"productName":"...","oneLiner":"...","targetAudience":"...","keywords":["..."],"valueProp":"..."}`;

/**
 * Use Claude to analyze scraped website content and extract structured product info.
 * Sends full page markdown (from Turndown) instead of just meta tags.
 */
export async function analyzeWebsite(
  scrape: WebScrapeResult,
): Promise<ProductAnalysis> {
  const client = new Anthropic();

  const content = [
    `URL: ${scrape.url}`,
    scrape.title ? `Title: ${scrape.title}` : '',
    scrape.description ? `Meta Description: ${scrape.description}` : '',
    scrape.pageMarkdown ? `\nPage Content:\n${scrape.pageMarkdown}` : '',
  ].filter(Boolean).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: ANALYZE_PROMPT,
      messages: [{ role: 'user', content }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
    return {
      productName: parsed.productName || fallbackName(scrape.title, scrape.url),
      oneLiner: parsed.oneLiner || scrape.description,
      targetAudience: parsed.targetAudience || '',
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      valueProp: parsed.valueProp || '',
    };
  } catch (error) {
    log.error(`analyzeWebsite failed: ${error instanceof Error ? error.message : error}`);
    return {
      productName: fallbackName(scrape.title, scrape.url),
      oneLiner: scrape.description,
      targetAudience: '',
      keywords: [],
      valueProp: '',
    };
  }
}

function fallbackName(title: string, url: string): string {
  const separators = /\s*[–\-|:·]\s*/;
  const parts = title.split(separators).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].split(/\s+/).length <= 4) {
    return parts[0];
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname.split('.')[0];
  } catch {
    return title || 'Unknown';
  }
}
