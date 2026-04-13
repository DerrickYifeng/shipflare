import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { scrapeUrl } from '@/tools/url-scraper';
import { auditSeo } from '@/tools/seo-audit';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:onboarding');

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { url } = await request.json();
  log.info(`POST /api/onboarding/extract url=${url}`);

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const scraped = await scrapeUrl(url);
  const seoAudit = await auditSeo(url);

  return NextResponse.json({
    url,
    name: scraped.title,
    description: scraped.description,
    keywords: scraped.keywords,
    valueProp: scraped.valueProp ?? '',
    ogImage: scraped.ogImage,
    seoAudit,
  });
}
