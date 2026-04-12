import * as cheerio from 'cheerio';

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
