import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { auditSeo } from '@/tools/seo-audit';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:onboarding');

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string; name?: string; description?: string; keywords?: string[]; valueProp?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url, name, description, keywords, valueProp } = body;
  log.info(`PUT /api/onboarding/profile name=${name}`);

  if (!url || !name || !description) {
    return NextResponse.json(
      { error: 'URL, name, and description are required' },
      { status: 400 },
    );
  }

  const seoAudit = await auditSeo(url);

  // Upsert product
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(products)
      .set({
        url,
        name,
        description,
        keywords: keywords ?? [],
        valueProp: valueProp ?? null,
        seoAuditJson: seoAudit,
        updatedAt: new Date(),
      })
      .where(eq(products.userId, session.user.id));
  } else {
    await db.insert(products).values({
      userId: session.user.id,
      url,
      name,
      description,
      keywords: keywords ?? [],
      valueProp: valueProp ?? null,
      seoAuditJson: seoAudit,
    });
  }

  return NextResponse.json({ success: true });
}
