import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { scrapeWebsite, analyzeWebsite } from '@/services/web-scraper';
import { auditSeo } from '@/tools/seo-audit';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:onboarding');

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url } = body;
  log.info(`POST /api/onboarding/extract url=${url}`);

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  // Scrape website with Turndown (full page → markdown)
  const scraped = await scrapeWebsite(url);

  // Run AI analysis and SEO audit in parallel
  const [analysis, seoAudit] = await Promise.all([
    analyzeWebsite(scraped),
    auditSeo(url),
  ]);

  return NextResponse.json({
    url,
    name: analysis.productName,
    description: analysis.oneLiner,
    keywords: analysis.keywords,
    valueProp: analysis.valueProp,
    targetAudience: analysis.targetAudience,
    ogImage: scraped.ogImage,
    seoAudit,
  });
}
