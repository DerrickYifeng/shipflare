import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';

export interface ScrapedProfile {
  title: string;
  description: string;
  keywords: string[];
  valueProp: string;
  ogImage: string | null;
  favicon: string | null;
  status: 'success' | 'not_found' | 'forbidden' | 'thin_content' | 'error';
  error?: string;
}

export interface ProductAnalysis {
  productName: string;
  oneLiner: string;
  targetAudience: string;
  keywords: string[];
  valueProp: string;
}

/**
 * Scrape a URL to extract product profile information.
 * Standalone tool (not an agent tool). Used during onboarding.
 */
export async function scrapeUrl(url: string): Promise<ScrapedProfile> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; ShipFlare/1.0; +https://shipflare.dev)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      return emptyProfile('not_found', 'Page not found (404)');
    }
    if (response.status === 403) {
      return emptyProfile('forbidden', 'Access denied (403)');
    }
    if (!response.ok) {
      return emptyProfile('error', `HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content') ??
      $('title').text().trim() ??
      '';

    const description =
      $('meta[property="og:description"]').attr('content') ??
      $('meta[name="description"]').attr('content') ??
      '';

    const keywordsStr = $('meta[name="keywords"]').attr('content') ?? '';
    const keywords = keywordsStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    // Extract value prop from H1 or first prominent heading
    const h1 = $('h1').first().text().trim();
    const valueProp = h1 || title;

    const ogImage =
      $('meta[property="og:image"]').attr('content') ?? null;

    const favicon =
      $('link[rel="icon"]').attr('href') ??
      $('link[rel="shortcut icon"]').attr('href') ??
      null;

    // Check for thin content
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    if (bodyText.length < 100) {
      return {
        title,
        description,
        keywords,
        valueProp,
        ogImage,
        favicon,
        status: 'thin_content',
        error: 'Page has very little text content',
      };
    }

    return {
      title,
      description,
      keywords,
      valueProp,
      ogImage,
      favicon,
      status: 'success',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyProfile('error', message);
  }
}

function emptyProfile(
  status: ScrapedProfile['status'],
  error: string,
): ScrapedProfile {
  return {
    title: '',
    description: '',
    keywords: [],
    valueProp: '',
    ogImage: null,
    favicon: null,
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
 * Use AI to analyze scraped page content and extract structured product info.
 * Much more reliable than parsing meta tags, especially for sites without SEO.
 */
export async function analyzeProduct(
  scraped: ScrapedProfile,
  url: string,
): Promise<ProductAnalysis> {
  const client = new Anthropic();

  // Build a concise page snapshot for the LLM
  const pageContent = [
    `URL: ${url}`,
    scraped.title ? `Title: ${scraped.title}` : '',
    scraped.description ? `Description: ${scraped.description}` : '',
    scraped.keywords.length > 0 ? `Meta keywords: ${scraped.keywords.join(', ')}` : '',
    scraped.valueProp ? `H1: ${scraped.valueProp}` : '',
  ].filter(Boolean).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: ANALYZE_PROMPT,
      messages: [{ role: 'user', content: pageContent }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
    return {
      productName: parsed.productName || fallbackName(scraped.title, url),
      oneLiner: parsed.oneLiner || scraped.description,
      targetAudience: parsed.targetAudience || '',
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      valueProp: parsed.valueProp || scraped.valueProp,
    };
  } catch {
    // Fallback to meta tag extraction if AI fails
    return {
      productName: fallbackName(scraped.title, url),
      oneLiner: scraped.description,
      targetAudience: '',
      keywords: scraped.keywords,
      valueProp: scraped.valueProp,
    };
  }
}

function fallbackName(title: string, url: string): string {
  const separators = /\s*[–\-|:·]\s*/;
  const parts = title.split(separators).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].split(/\s+/).length <= 4) {
    return parts[0];
  }
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  return hostname.split('.')[0];
}
