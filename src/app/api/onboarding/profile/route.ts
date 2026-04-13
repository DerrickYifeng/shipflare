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

  let body: { url?: string; name?: string; description?: string; keywords?: string[]; valueProp?: string; merge?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url, name, description, keywords, valueProp, merge } = body;
  log.info(`PUT /api/onboarding/profile name=${name} merge=${!!merge}`);

  if (!name || !description) {
    return NextResponse.json(
      { error: 'Name and description are required' },
      { status: 400 },
    );
  }

  const seoAudit = url ? await auditSeo(url) : null;

  // Upsert product
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  const PLACEHOLDER_NAMES = ['', 'Untitled Product'];
  const PLACEHOLDER_DESCS = ['', '-'];

  if (existing.length > 0 && merge) {
    // Merge: keep existing non-placeholder values, union keywords
    const prev = existing[0];
    const mergedName = PLACEHOLDER_NAMES.includes(prev.name) ? name : prev.name;
    const mergedDesc = PLACEHOLDER_DESCS.includes(prev.description) ? description : prev.description;
    const mergedKeywords = [...new Set([...prev.keywords, ...(keywords ?? [])])];
    const mergedValueProp = prev.valueProp || valueProp || null;

    await db
      .update(products)
      .set({
        ...(url !== undefined ? { url: url || null } : {}),
        name: mergedName,
        description: mergedDesc,
        keywords: mergedKeywords,
        valueProp: mergedValueProp,
        ...(seoAudit !== null ? { seoAuditJson: seoAudit } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.userId, session.user.id));
  } else if (existing.length > 0) {
    await db
      .update(products)
      .set({
        ...(url !== undefined ? { url: url || null } : {}),
        name,
        description,
        keywords: keywords ?? [],
        valueProp: valueProp ?? null,
        ...(seoAudit !== null ? { seoAuditJson: seoAudit } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.userId, session.user.id));
  } else {
    await db.insert(products).values({
      userId: session.user.id,
      url: url || null,
      name,
      description,
      keywords: keywords ?? [],
      valueProp: valueProp ?? null,
      seoAuditJson: seoAudit,
    });
  }

  return NextResponse.json({ success: true });
}
