import * as cheerio from 'cheerio';

export interface SeoAuditResult {
  score: number; // 0-100
  checks: SeoCheck[];
  recommendations: string[];
}

interface SeoCheck {
  name: string;
  passed: boolean;
  value?: string;
  recommendation?: string;
}

/**
 * Run an SEO audit on a URL. Returns score + actionable recommendations.
 * Standalone tool (not an agent tool). Used during onboarding.
 */
export async function auditSeo(url: string): Promise<SeoAuditResult> {
  const checks: SeoCheck[] = [];

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; ShipFlare/1.0; +https://shipflare.dev)',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { score: 0, checks: [], recommendations: ['Page returned non-200 status'] };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Meta title
    const title = $('title').text().trim();
    const titleLen = title.length;
    checks.push({
      name: 'Meta title',
      passed: titleLen >= 30 && titleLen <= 60,
      value: `${titleLen} chars`,
      recommendation:
        titleLen < 30
          ? 'Title too short (aim for 30-60 chars)'
          : titleLen > 60
            ? 'Title too long (aim for 30-60 chars)'
            : undefined,
    });

    // Meta description
    const desc =
      $('meta[name="description"]').attr('content')?.trim() ?? '';
    const descLen = desc.length;
    checks.push({
      name: 'Meta description',
      passed: descLen >= 120 && descLen <= 160,
      value: `${descLen} chars`,
      recommendation:
        descLen === 0
          ? 'Missing meta description'
          : descLen < 120
            ? 'Description too short (aim for 120-160 chars)'
            : descLen > 160
              ? 'Description too long (aim for 120-160 chars)'
              : undefined,
    });

    // H1 count
    const h1Count = $('h1').length;
    checks.push({
      name: 'H1 heading',
      passed: h1Count === 1,
      value: `${h1Count} found`,
      recommendation:
        h1Count === 0
          ? 'Missing H1 heading'
          : h1Count > 1
            ? 'Multiple H1 headings (use only one)'
            : undefined,
    });

    // OG tags
    const hasOgTitle = !!$('meta[property="og:title"]').attr('content');
    const hasOgDesc = !!$('meta[property="og:description"]').attr('content');
    const hasOgImage = !!$('meta[property="og:image"]').attr('content');
    checks.push({
      name: 'Open Graph tags',
      passed: hasOgTitle && hasOgDesc && hasOgImage,
      value: [
        hasOgTitle ? 'title' : null,
        hasOgDesc ? 'desc' : null,
        hasOgImage ? 'image' : null,
      ]
        .filter(Boolean)
        .join(', ') || 'none',
      recommendation:
        !hasOgTitle || !hasOgDesc || !hasOgImage
          ? 'Add missing OG tags for social sharing'
          : undefined,
    });

    // Canonical
    const canonical = $('link[rel="canonical"]').attr('href');
    checks.push({
      name: 'Canonical URL',
      passed: !!canonical,
      recommendation: !canonical ? 'Add a canonical URL' : undefined,
    });

    // Viewport
    const viewport = $('meta[name="viewport"]').attr('content');
    checks.push({
      name: 'Viewport meta',
      passed: !!viewport,
      recommendation: !viewport ? 'Add viewport meta tag for mobile' : undefined,
    });

    // FAQ schema
    const hasFaqSchema = html.includes('"@type":"FAQPage"') || html.includes('"@type": "FAQPage"');
    checks.push({
      name: 'FAQ Schema',
      passed: hasFaqSchema,
      recommendation: !hasFaqSchema
        ? 'Consider adding FAQ structured data'
        : undefined,
    });

    const passed = checks.filter((c) => c.passed).length;
    const score = Math.round((passed / checks.length) * 100);
    const recommendations = checks
      .filter((c) => c.recommendation)
      .map((c) => c.recommendation!);

    return { score, checks, recommendations };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { score: 0, checks: [], recommendations: [`Audit failed: ${message}`] };
  }
}
